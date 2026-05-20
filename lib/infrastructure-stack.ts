import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export class InfrastructureStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);


    const vpc = new ec2.Vpc(this, 'Vpc', {
      //at current I have left as one az, as we will likley be using EBS, which is scoped to AZ zone.
      maxAzs: 1,
      natGateways: 1,
      subnetConfiguration: [
        {
          //public subnets
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          // leaving as default
          cidrMask: 24,
        },
        {
          //private subnets
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });
  }
}
