package aws

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
)

type EC2Client struct {
	*ec2.Client
}

func NewEC2Client(ctx context.Context, region string) (*EC2Client, error) {
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region))
	if err != nil {
		return nil, fmt.Errorf("failed to load AWS config: %w", err)
	}
	return &EC2Client{Client: ec2.NewFromConfig(cfg)}, nil
}

type VPCInfo struct {
	ID        string
	CIDR      string
	Name      string
	IsDefault bool
}

func (c *EC2Client) ListVPCs(ctx context.Context) ([]VPCInfo, error) {
	output, err := c.DescribeVpcs(ctx, &ec2.DescribeVpcsInput{})
	if err != nil {
		return nil, fmt.Errorf("failed to describe VPCs: %w", err)
	}

	var vpcs []VPCInfo
	for _, vpc := range output.Vpcs {
		name := ""
		for _, tag := range vpc.Tags {
			if *tag.Key == "Name" {
				name = *tag.Value
				break
			}
		}

		vpcs = append(vpcs, VPCInfo{
			ID:        *vpc.VpcId,
			CIDR:      *vpc.CidrBlock,
			Name:      name,
			IsDefault: *vpc.IsDefault,
		})
	}

	return vpcs, nil
}
