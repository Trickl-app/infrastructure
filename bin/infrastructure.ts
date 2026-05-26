#!/usr/bin/env node

// entry point for the CDK app. This file is where all stacks are registered and wired together.
// CDK reads this file when you run cdk synth or cdk deploy.
import * as cdk from 'aws-cdk-lib/core';
import { NetworkStack } from '../lib/network-stack';
import { ApplicationStack } from '../lib/application-stack';
import { DataStack } from '../lib/data-stack';

// the App is the root of the CDK construct tree — everything lives inside it.
const app = new cdk.App();

// NetworkStack is deployed first. It defines the VPC, subnets, and security groups.
// We store a reference to it so we can pass its outputs (vpc, security groups) to other stacks.
const network = new NetworkStack(app, 'NetworkStack', {
  // deploys into whichever AWS account and region the client's credentials point to.
  // CDK_DEFAULT_ACCOUNT and CDK_DEFAULT_REGION are set automatically by the CDK CLI.
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});

const data = new DataStack(app, 'DataStack', {
  env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  vpc: network.vpc,
  rdsSg: network.rdsSg
})

// ApplicationStack depends on NetworkStack. The VPC and security groups are passed in via props
// so this stack knows where to place its resources and which security groups to attach.
new ApplicationStack(app, 'ApplicationStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  // pass network resources through so ApplicationStack can place and connect its resources correctly
  vpc: network.vpc,
  albSg: network.albSg,
  ecsSg: network.ecsSg,
  metricsBucket: data.metricsBucket,
  rdsEndpoint: data.rdsEndpoint,
  dbSecret: data.dbSecret,
});
