#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { InfrastructureStack } from '../lib/infrastructure-stack';

const app = new cdk.App();
new InfrastructureStack(app, 'InfrastructureStack', {

  // This uses the users authenticated AWS account on their environment in order to be able to check their existing infrastructure
   env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },

});
