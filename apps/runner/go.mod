module github.com/alethialabs-io/alethialabs/apps/runner

go 1.26.6

require (
	github.com/alethialabs-io/alethialabs/packages/core v0.0.0
	github.com/aws/aws-sdk-go-v2 v1.45.1
	github.com/aws/aws-sdk-go-v2/config v1.33.2
	github.com/aws/aws-sdk-go-v2/service/ec2 v1.327.0 // indirect
	github.com/aws/aws-sdk-go-v2/service/eks v1.96.0 // indirect
	github.com/aws/aws-sdk-go-v2/service/s3 v1.110.0 // indirect
	github.com/aws/aws-sdk-go-v2/service/sts v1.48.0
	github.com/hashicorp/go-version v1.9.0 // indirect
	github.com/hashicorp/terraform-exec v0.25.3 // indirect
	github.com/hashicorp/terraform-json v0.28.0 // indirect
)

require (
	github.com/Azure/azure-sdk-for-go/sdk/azcore v1.23.1
	github.com/Azure/azure-sdk-for-go/sdk/azidentity v1.14.1
	github.com/aws/aws-sdk-go-v2/credentials v1.20.2
	github.com/aws/aws-sdk-go-v2/feature/rds/auth v1.7.1
	github.com/aws/aws-sdk-go-v2/service/ecr v1.63.0
	github.com/aws/aws-sdk-go-v2/service/ecrpublic v1.45.0
	github.com/aws/smithy-go v1.28.1
	github.com/getsentry/sentry-go v0.49.0
	github.com/siderolabs/talos/pkg/machinery v1.13.9
	go.opentelemetry.io/otel v1.46.0
	go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp v1.46.0
	go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp v1.46.0
	go.opentelemetry.io/otel/sdk v1.46.0
	go.opentelemetry.io/otel/sdk/metric v1.46.0
	go.opentelemetry.io/otel/trace v1.46.0
	golang.org/x/oauth2 v0.36.0
	gopkg.in/yaml.v3 v3.0.1
)

require (
	cloud.google.com/go/compute/metadata v0.9.0 // indirect
	dario.cat/mergo v1.0.0 // indirect
	github.com/Azure/azure-sdk-for-go/sdk/internal v1.12.0 // indirect
	github.com/AzureAD/microsoft-authentication-library-for-go v1.8.0 // indirect
	github.com/Microsoft/go-winio v0.6.2 // indirect
	github.com/ProtonMail/go-crypto v1.4.1 // indirect
	github.com/ProtonMail/go-mime v0.0.0-20230322103455-7d82a3887f2f // indirect
	github.com/ProtonMail/gopenpgp/v2 v2.10.0 // indirect
	github.com/adrg/xdg v0.5.3 // indirect
	github.com/agext/levenshtein v1.2.1 // indirect
	github.com/apparentlymart/go-textseg/v15 v15.0.0 // indirect
	github.com/apparentlymart/go-textseg/v17 v17.0.1 // indirect
	github.com/aws/aws-sdk-go-v2/aws/protocol/eventstream v1.7.20 // indirect
	github.com/aws/aws-sdk-go-v2/feature/ec2/imds v1.19.1 // indirect
	github.com/aws/aws-sdk-go-v2/internal/configsources v1.5.1 // indirect
	github.com/aws/aws-sdk-go-v2/internal/endpoints/v2 v2.8.1 // indirect
	github.com/aws/aws-sdk-go-v2/internal/v4a v1.5.1 // indirect
	github.com/aws/aws-sdk-go-v2/service/accessanalyzer v1.54.0 // indirect
	github.com/aws/aws-sdk-go-v2/service/iam v1.62.0 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/accept-encoding v1.13.19 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/checksum v1.11.1 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/presigned-url v1.14.1 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/s3shared v1.20.1 // indirect
	github.com/aws/aws-sdk-go-v2/service/signin v1.8.0 // indirect
	github.com/aws/aws-sdk-go-v2/service/sso v1.36.0 // indirect
	github.com/aws/aws-sdk-go-v2/service/ssooidc v1.41.0 // indirect
	github.com/cenkalti/backoff/v4 v4.3.0 // indirect
	github.com/cenkalti/backoff/v5 v5.0.3 // indirect
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/cloudflare/circl v1.6.3 // indirect
	github.com/containerd/go-cni v1.1.13 // indirect
	github.com/containernetworking/cni v1.3.0 // indirect
	github.com/cosi-project/runtime v1.14.1 // indirect
	github.com/cyphar/filepath-securejoin v0.6.1 // indirect
	github.com/dustin/go-humanize v1.0.1 // indirect
	github.com/emirpasic/gods v1.18.1 // indirect
	github.com/gertd/go-pluralize v0.2.1 // indirect
	github.com/go-git/gcfg v1.5.1-0.20230307220236-3a3c6141e376 // indirect
	github.com/go-git/go-billy/v5 v5.9.0 // indirect
	github.com/go-git/go-git/v5 v5.19.2 // indirect
	github.com/go-logr/logr v1.4.4 // indirect
	github.com/go-logr/stdr v1.2.2 // indirect
	github.com/golang-jwt/jwt/v5 v5.3.1 // indirect
	github.com/golang/groupcache v0.0.0-20241129210726-2c02b8208cf8 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/grpc-ecosystem/grpc-gateway/v2 v2.30.0 // indirect
	github.com/hashicorp/errwrap v1.1.0 // indirect
	github.com/hashicorp/go-multierror v1.1.1 // indirect
	github.com/hashicorp/hcl/v2 v2.24.0 // indirect
	github.com/jbenet/go-context v0.0.0-20150711004518-d14ea06fba99 // indirect
	github.com/kevinburke/ssh_config v1.2.0 // indirect
	github.com/klauspost/cpuid/v2 v2.3.0 // indirect
	github.com/kylelemons/godebug v1.1.0 // indirect
	github.com/mitchellh/go-wordwrap v1.0.1 // indirect
	github.com/opencontainers/go-digest v1.0.0 // indirect
	github.com/opencontainers/image-spec v1.1.1 // indirect
	github.com/opencontainers/runtime-spec v1.3.0 // indirect
	github.com/petermattis/goid v0.0.0-20240813172612-4fcff4a6cae7 // indirect
	github.com/pjbgf/sha1cd v0.6.0 // indirect
	github.com/pkg/browser v0.0.0-20240102092130-5ac0b6a4141c // indirect
	github.com/pkg/errors v0.9.1 // indirect
	github.com/planetscale/vtprotobuf v0.6.1-0.20250313105119-ba97887b0a25 // indirect
	github.com/sasha-s/go-deadlock v0.3.5 // indirect
	github.com/sergi/go-diff v1.3.2-0.20230802210424-5b0b94c5c0d3 // indirect
	github.com/siderolabs/crypto v0.6.5 // indirect
	github.com/siderolabs/gen v0.8.7 // indirect
	github.com/siderolabs/go-api-signature v0.3.12 // indirect
	github.com/siderolabs/go-pointer v1.0.1 // indirect
	github.com/siderolabs/protoenc v0.2.4 // indirect
	github.com/skeema/knownhosts v1.3.1 // indirect
	github.com/xanzy/ssh-agent v0.3.3 // indirect
	github.com/zclconf/go-cty v1.19.0 // indirect
	go.opentelemetry.io/auto/sdk v1.2.1 // indirect
	go.opentelemetry.io/otel/exporters/otlp/otlptrace v1.46.0 // indirect
	go.opentelemetry.io/otel/metric v1.46.0 // indirect
	go.opentelemetry.io/proto/otlp v1.11.0 // indirect
	go.uber.org/multierr v1.11.0 // indirect
	go.uber.org/zap v1.27.1 // indirect
	go.yaml.in/yaml/v4 v4.0.0-rc.4 // indirect
	golang.org/x/crypto v0.55.0 // indirect
	golang.org/x/mod v0.40.0 // indirect
	golang.org/x/net v0.58.0 // indirect
	golang.org/x/sync v0.22.0 // indirect
	golang.org/x/sys v0.47.0 // indirect
	golang.org/x/text v0.41.0 // indirect
	golang.org/x/time v0.15.0 // indirect
	golang.org/x/tools v0.49.0 // indirect
	google.golang.org/genproto/googleapis/api v0.0.0-20260819154853-08b0e4226688 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20260819154853-08b0e4226688 // indirect
	google.golang.org/grpc v1.83.1 // indirect
	google.golang.org/protobuf v1.36.12 // indirect
	gopkg.in/warnings.v0 v0.1.2 // indirect
	oras.land/oras-go/v2 v2.6.2 // indirect
)

replace github.com/alethialabs-io/alethialabs/packages/core => ../../packages/core
