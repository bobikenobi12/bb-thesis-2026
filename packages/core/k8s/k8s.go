// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	alethiaaws "github.com/alethialabs-io/alethialabs/packages/core/cloud/aws"
	"github.com/alethialabs-io/alethialabs/packages/core/names"
	"github.com/alethialabs-io/alethialabs/packages/core/utils"
	"github.com/aws/aws-sdk-go-v2/service/eks"
	"gopkg.in/yaml.v3"
)

// k8sNameRe is the RFC-1123 DNS-label charset kubernetes enforces on namespaces. Apply
// interpolates the namespace into a `bash -c` command string, so we fail closed on anything
// that isn't a valid label rather than let it reach the shell.
//
// One grammar, generated from apps/console/lib/validations/names.ts (#3665) — argocd.k8sNameRe is
// now the SAME value rather than a second spelling of it.
var k8sNameRe = names.NamespacePattern

var executeCommand = utils.ExecuteCommand

type K8sCLI struct {
	Profile string
	Region  string
	DryRun  bool
	// eksClient is the interface slice of *eks.Client used here (DescribeCluster) — an interface so
	// GetContext's cluster-readiness handling is unit-testable against a fake.
	eksClient alethiaaws.DescribeClusterAPI
}

func NewK8sCLI(opts alethiaaws.AWSOptions, dryRun bool) (*K8sCLI, error) {
	cfg, err := alethiaaws.LoadConfig(context.Background(), opts)
	if err != nil {
		return nil, fmt.Errorf("unable to load SDK config: %w", err)
	}

	return &K8sCLI{
		Profile:   opts.Profile,
		Region:    opts.Region,
		DryRun:    dryRun,
		eksClient: eks.NewFromConfig(cfg),
	}, nil
}

func (k *K8sCLI) GetContext(clusterName string, logger *utils.Logger) error {
	logger.Info(fmt.Sprintf("Getting context for cluster: %s", clusterName), "k8s")

	// Safely resolve the cluster's connection details — returns ErrClusterNotReady (never a nil
	// deref) when the cluster isn't ACTIVE yet, e.g. kubeconfig requested moments after provisioning.
	conn, err := alethiaaws.ResolveEKSClusterConn(context.Background(), k.eksClient, clusterName)
	if err != nil {
		return err
	}
	// A per-invocation temp dir (not the cwd-relative "temp/kubeconfig"), so concurrent jobs sharing
	// a working directory can never clobber each other's kubeconfig — a wrong-cluster kubeconfig is a
	// correctness + security hazard (#952).
	kubeconfigDir, err := os.MkdirTemp("", "alethia-kubeconfig-*")
	if err != nil {
		return fmt.Errorf("failed to create kubeconfig directory: %w", err)
	}
	kubeconfigPath := filepath.Join(kubeconfigDir, "kubeconfig")

	clusterConfig := map[string]interface{}{
		"apiVersion": "v1",
		"kind":       "Config",
		"clusters": []interface{}{
			map[string]interface{}{
				"cluster": map[string]interface{}{
					"server":                     conn.Endpoint,
					"certificate-authority-data": conn.CAData,
				},
				"name": conn.ARN,
			},
		},
		"contexts": []interface{}{
			map[string]interface{}{
				"context": map[string]interface{}{
					"cluster": conn.ARN,
					"user":    conn.ARN,
				},
				"name": conn.ARN,
			},
		},
		"current-context": conn.ARN,
		"preferences":     map[string]interface{}{},
		"users": []interface{}{
			map[string]interface{}{
				"name": conn.ARN,
				"user": map[string]interface{}{
					// CLI-free: authenticate via the runner's own kube-token exec-plugin (in-process
					// presigned STS token), not the aws-iam-authenticator binary (no longer in the image).
					"exec": map[string]interface{}{
						"apiVersion": "client.authentication.k8s.io/v1beta1",
						"command":    execSelfPath(),
						"args": []string{
							"kube-token",
							"--provider",
							"aws",
							"--cluster",
							clusterName,
							"--region",
							k.Region,
						},
					},
				},
			},
		},
	}

	data, err := yaml.Marshal(clusterConfig)
	if err != nil {
		return fmt.Errorf("failed to marshal kubeconfig: %w", err)
	}

	if err := os.WriteFile(kubeconfigPath, data, 0600); err != nil {
		return fmt.Errorf("failed to write kubeconfig: %w", err)
	}

	logger.Info(fmt.Sprintf("Kubeconfig written to %s", kubeconfigPath), "k8s")
	return nil
}

// execSelfPath resolves the running binary's absolute path for use as a Kubernetes
// exec-credential-plugin command (the runner mints tokens in-process). Falls back to
// "runner" (PATH lookup) if the path can't be determined.
func execSelfPath() string {
	if self, err := os.Executable(); err == nil && self != "" {
		return self
	}
	return "runner"
}

func (k *K8sCLI) Apply(namespace, manifest string, env map[string]string, logger *utils.Logger) error {
	// namespace and manifest are interpolated into a `bash -c` command string. Fail closed on a
	// namespace that isn't an RFC-1123 DNS label, and shell-quote the manifest path, so neither can
	// smuggle shell metacharacters into the executed command (command-injection guard, #944).
	if !k8sNameRe.MatchString(namespace) {
		return fmt.Errorf("refusing to apply: namespace %q is not a valid RFC-1123 DNS label", namespace)
	}
	cmd := fmt.Sprintf("kubectl apply -n %s -f %s", namespace, utils.ShellQuote(manifest))
	logger.Info(fmt.Sprintf("Running kubectl apply command for %s", manifest), "k8s")

	serverDryRunCmd := cmd + " --dry-run=server"

	envList := make([]string, 0, len(env))
	for k, v := range env {
		envList = append(envList, fmt.Sprintf("%s=%s", strings.ToUpper(k), v))
	}

	if k.DryRun {
		logger.Info("Performing server-side dry-run...", "k8s")
		err := executeCommand(serverDryRunCmd, ".", envList, nil, nil)
		if err != nil {
			logger.Warn("Server-side dry-run failed. It might be expected in dry-run mode.", "k8s")
		} else {
			logger.Info("Server-side dry-run succeeded.", "k8s")
		}
	} else {
		logger.Info("Performing server-side dry-run before actual execution...", "k8s")
		err := executeCommand(serverDryRunCmd, ".", envList, nil, nil)
		if err != nil {
			return fmt.Errorf("server-side dry-run failed: %w", err)
		}
		logger.Info("Server-side dry-run succeeded. Proceeding with actual command.", "k8s")

		err = executeCommand(cmd, ".", envList, nil, nil)
		if err != nil {
			return fmt.Errorf("kubectl apply failed: %w", err)
		}
	}

	return nil
}
