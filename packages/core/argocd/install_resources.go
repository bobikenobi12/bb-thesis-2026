// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import "fmt"

// The argo-cd chart ships `resources: {}` for every component, and that is not "no opinion" — it is
// a QoS CLASS. A container with no requests is BestEffort: the kubelet gives its cgroup the CPU
// SHARE FLOOR, and the eviction ranking puts it first out the door under node memory pressure. Every
// kube-system pod on a GKE node carries requests, so an unrequested argocd-repo-server loses every
// contention decision on that node by construction — not by luck, and not only when the node is
// small.
//
// This file is the one place that fixes that, and like InstallProbeValues it is applied to EVERY
// install on every cloud: a QoS class is a property of the CONTAINER, not of a cloud, an ingress or
// a node size.
//
// ── Why repo-server, and why ONLY repo-server ──
//
// #3855. Two gcp floor nightlies on the same sha (runs 33605830312 and 33731101952) both died at
// `argocd-ready` with the BYO Application never completing ONE manifest render. The two proximate
// errors were different and the invariant was not:
//
//	dns: A record lookup error: lookup argo-cd-argocd-repo-server on 10.2.0.10:53: i/o timeout
//	rpc error: code = DeadlineExceeded desc = context deadline exceeded
//
// The first is the application-controller unable to resolve its own repo-server through a starved
// kube-dns; the second is repo-server blowing its own gRPC render deadline. repo-server is the
// component that runs `helm template` — the CPU-hungriest work an ArgoCD install does — and it is
// the component that failed, on the only cloud whose floor node is under 4 GiB. aws (t3.large) and
// azure (Standard_D2s_v3), both 8 GiB, passed the SAME assertion on the SAME chart in the SAME runs.
//
// The other components are left BestEffort DELIBERATELY. Giving repo-server the only request on the
// install is precisely what makes it win the contention decisions above; requesting for everything
// would restore the tie this exists to break, and would do it by reserving capacity on the node that
// has the least to spare.
//
// ── What these numbers are, and what they are NOT ──
//
// They are NOT a measured working set, and nothing here should be read as one. ArgoCD's fit on this
// node has never been measured — `.github/workflows/e2e-nightly.yml` says so at the gcp shape, and
// one paid gcp floor run is the only thing that can settle it.
//
// What IS established is the CLASS, and it needs no measurement: repo-server has no request at all,
// so it runs at the share floor. The change from "no request" to "any request" is categorical. Only
// the MAGNITUDE is a judgement, so it is made the way a judgement with no number behind it should
// be — the SMALLEST value that achieves the class change while staying comfortably schedulable on
// the smallest node the floor runs on. A gcp `e2-medium` allocates ~940m CPU and ~2972 MiB after
// GKE's reservations; 100m and 256Mi are ~11% and ~9% of that, which cannot turn a running pod into
// a Pending one on any node the product offers.
//
// REQUESTS ONLY, NO LIMITS, and the asymmetry is the whole design. A CPU limit would throttle
// exactly the render this exists to let finish, and a memory limit would OOM-kill a large
// `helm template` outright — both would convert a slow render into a failed one, which is the defect
// being fixed, not a fix for it. A request is a FLOOR the scheduler honours; a limit is a CEILING
// the kernel enforces. Only the floor was missing.
//
// Rendered as a values FILE and passed as a second `-f`, for the same reason as the probe values:
// helm deep-merges values files left to right, so `repoServer.resources` here and
// `repoServer.readinessProbe` there both survive, and each file states one whole idea.
const (
	// RepoServerCPURequest is the CPU request that moves argocd-repo-server off the cgroup share
	// floor. Its job is the QoS class; the magnitude is deliberately the smallest that does that.
	RepoServerCPURequest = "100m"
	// RepoServerMemoryRequest is the memory request that moves argocd-repo-server out of BestEffort,
	// so it is no longer first in the node's eviction ranking.
	RepoServerMemoryRequest = "256Mi"
)

// InstallResourceValues renders the argo-cd chart values that give argocd-repo-server an explicit
// resource REQUEST, so it is scheduled and shares CPU as a Burstable pod rather than starved as a
// BestEffort one.
//
// Like InstallProbeValues it takes no arguments and cannot fail — the values are constants, not
// project data.
func InstallResourceValues() string {
	return fmt.Sprintf(
		"repoServer:\n"+
			"  resources:\n"+
			"    requests:\n"+
			"      cpu: %s\n"+
			"      memory: %s\n",
		RepoServerCPURequest, RepoServerMemoryRequest)
}
