package aws

import (
	"context"
	"errors"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

type S3Client struct {
	*s3.Client
}

func NewS3Client(ctx context.Context, region string) (*S3Client, error) {
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region))
	if err != nil {
		return nil, fmt.Errorf("failed to load AWS config: %w", err)
	}
	return &S3Client{Client: s3.NewFromConfig(cfg)}, nil
}

func (c *S3Client) CreateS3BucketIfNotExists(ctx context.Context, bucketName string, region string, dryRun bool) error {
	_, err := c.HeadBucket(ctx, &s3.HeadBucketInput{
		Bucket: &bucketName,
	})

	if err != nil {
		var nfe *types.NotFound
		if errors.As(err, &nfe) {
			// Bucket does not exist, so create it
			fmt.Printf("Creating bucket '%s' in region %s...\n", bucketName, region)

			if dryRun {
				fmt.Println("Dry-run mode: Skipping actual creation of bucket.")
				return nil
			}

			createBucketInput := &s3.CreateBucketInput{
				Bucket: &bucketName,
				CreateBucketConfiguration: &types.CreateBucketConfiguration{
					LocationConstraint: types.BucketLocationConstraint(region),
				},
			}

			_, err = c.CreateBucket(ctx, createBucketInput)
			if err != nil {
				return fmt.Errorf("failed to create bucket '%s': %w", bucketName, err)
			}

			fmt.Printf("Bucket '%s' created successfully.\n", bucketName)
			return nil
		}
		// An error other than "NotFound" occurred
		return fmt.Errorf("failed to check for bucket '%s': %w", bucketName, err)
	}

	// Bucket already exists
	fmt.Printf("Bucket '%s' already exists.\n", bucketName)
	return nil
}
