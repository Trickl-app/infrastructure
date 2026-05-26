import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { DataStack } from '../lib/data-stack';
import { NetworkStack } from '../lib/network-stack';

// synthesize the stack once and reuse for all tests in this file
const app = new cdk.App();
const network = new NetworkStack(app, 'TestNetworkStack');
const stack = new DataStack(app, 'TestDataStack', {
  vpc: network.vpc,
  rdsSg: network.rdsSg,
});
const template = Template.fromStack(stack);

// ── RDS ────────────────────────────────────────────────────────────────────

// checks that only one RDS instance is created
test('RDS instance is created', () => {
  template.resourceCountIs('AWS::RDS::DBInstance', 1);
});

// checks that postgres database engine was used
test('RDS instance uses Postgres engine', () => {
  template.hasResourceProperties('AWS::RDS::DBInstance', {
    Engine: 'postgres',
  });
});

test('RDS instance has deletion protection enabled', () => {
  template.hasResourceProperties('AWS::RDS::DBInstance', {
    DeletionProtection: true,
  });
});

test('RDS instance is in the private subnet', () => {
  template.hasResourceProperties('AWS::RDS::DBInstance', {
    MultiAZ: false,
    PubliclyAccessible: false,
  });
});

test('RDS instance type is t3.micro', () => {
  template.hasResourceProperties('AWS::RDS::DBInstance', {
    DBInstanceClass: 'db.t3.micro',
  });
});

// ── S3 Metrics Bucket ──────────────────────────────────────────────────────
// Vector writes raw metrics to this bucket. EBS lives in ApplicationStack,
// not here — the old EBS tests in this file were misplaced and have been removed.

test('S3 metrics bucket is created', () => {
  template.resourceCountIs('AWS::S3::Bucket', 1);
});

// confirms all public access to the raw metrics archive is blocked
test('S3 metrics bucket blocks all public access', () => {
  template.hasResourceProperties('AWS::S3::Bucket', {
    PublicAccessBlockConfiguration: Match.objectLike({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    }),
  });
});

// confirms data at rest is encrypted using S3-managed keys
test('S3 metrics bucket uses S3-managed encryption', () => {
  template.hasResourceProperties('AWS::S3::Bucket', {
    BucketEncryption: Match.objectLike({
      ServerSideEncryptionConfiguration: Match.arrayWith([
        Match.objectLike({
          ServerSideEncryptionByDefault: Match.objectLike({ SSEAlgorithm: 'AES256' }),
        }),
      ]),
    }),
  });
});
