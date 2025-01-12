import * as aws from '@pulumi/aws';
import * as awsx from '@pulumi/awsx';
import * as eks from '@pulumi/eks';
import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';
import * as kx from '@pulumi/kubernetesx';
import { Config, Output } from '@pulumi/pulumi';
import * as random from '@pulumi/random';

const config = new Config();
const kubeSystemNamespace = 'kube-system';
const pulumiStack = pulumi.getStack();

// Create a new VPC for the cluster.
const vpc = new awsx.ec2.Vpc(`ai-eks-vpc-${pulumiStack}`, {
  numberOfNatGateways: 1,
  tags: {
    managedBy: 'aitomatic',
    stack: pulumiStack
  },
});

// IAM roles for the node group
const role = new aws.iam.Role(`ai-eks-ngrole-${pulumiStack}`, {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
    Service: 'ec2.amazonaws.com'
  }),
  tags: {
    managedBy: 'aitomatic',
    stack: pulumiStack
  }
});
let counter = 0;
for (const policyArn of [
  'arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy',
  'arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy',
  'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly'
]) {
  new aws.iam.RolePolicyAttachment(
    `ai-eks-ngrole-policy-${pulumiStack}-${counter++}`,
    { policyArn, role }
  );
}

// Create the EKS cluster itself without default node group.
const cluster = new eks.Cluster(`ai-eks-cluster-${pulumiStack}`, {
  skipDefaultNodeGroup: true,
  vpcId: vpc.id,
  privateSubnetIds: vpc.privateSubnetIds,
  publicSubnetIds: vpc.publicSubnetIds,
  nodeAssociatePublicIpAddress: true,
  createOidcProvider: true,
  enabledClusterLogTypes: [
    'api',
    'audit',
    'authenticator',
    'controllerManager',
    'scheduler'
  ],
  tags: {
    managedBy: 'aitomatic',
    stack: pulumiStack
  },
  instanceRoles: [role],
  providerCredentialOpts: {
    profileName: config.get('aws:profile')
  }
});

// Create a simple AWS managed node group using a cluster as input.
const managedNodeGroup = eks.createManagedNodeGroup(
  `ai-eks-mng--${pulumiStack}`,
  {
    cluster: cluster,
    nodeGroupName: `ai-eks-mng--${pulumiStack}`,
    nodeRoleArn: role.arn,
    labels: { ondemand: 'true' },
    tags: { 
      org: 'pulumi', 
      managedBy: 'aitomatic',
      stack: 'pulumiStack'
    },
    scalingConfig: {
      minSize: 2,
      maxSize: 20,
      desiredSize: 2
    },
  },
  cluster
);

// Export the cluster's kubeconfig.
export const kubeconfig = cluster.kubeconfig;

// Create PostgreSQL database for System
const dbPassword = new random.RandomPassword('aitomatic-system-db-password', {
  length: 16,
  special: false
});

const dbSubnetGroup = new aws.rds.SubnetGroup(`ai-db-sn-${pulumiStack}`, {
  subnetIds: vpc.privateSubnetIds,
  tags: {
    Name: 'RDS Subnet Group',
    managedBy: 'aitomatic',
    stack: pulumiStack
  }
});


const db = new aws.rds.Instance(`ai-db-${pulumiStack}`, {
  allocatedStorage: 10,
  maxAllocatedStorage: 100,
  engine: 'postgres',
  engineVersion: '11.10',
  instanceClass: 'db.t3.medium',
  password: dbPassword.result,
  skipFinalSnapshot: true,
  vpcSecurityGroupIds: [
    cluster.clusterSecurityGroup.id,
    cluster.nodeSecurityGroup.id
  ],
  username: 'postgres',
  dbSubnetGroupName: dbSubnetGroup.name,
  tags: {
    managedBy: 'aitomatic',
    stack: pulumiStack
  }
});

// Create namespaces
const aiSystemNs = new k8s.core.v1.Namespace(
  'aitomatic-system',
  {
    metadata: {
      name: 'aitomatic-system',
      labels: { 'istio-injection': 'enabled' }
    }
  },
  {
    dependsOn: [cluster, managedNodeGroup],
    provider: cluster.provider
  }
);
const aiInfraNs = new k8s.core.v1.Namespace(
  'aitomatic-infra',
  {
    metadata: {
      name: 'aitomatic-infra',
      labels: { 'istio-injection': 'enabled' }
    }
  },
  {
    dependsOn: [cluster, managedNodeGroup],
    provider: cluster.provider
  }
);
const aiAppsNs = new k8s.core.v1.Namespace(
  'aitomatic-apps',
  {
    metadata: {
      name: 'aitomatic-apps',
      labels: { 'istio-injection': 'enabled' }
    }
  },
  {
    dependsOn: [cluster, managedNodeGroup],
    provider: cluster.provider
  }
);

// Deploy metrics-server from Bitnami Helm Repo to aitomatic-system Namespace
const metricsServerChart = new k8s.helm.v3.Chart(
  'kubesys-ms',
  {
    chart: 'metrics-server',
    version: '3.5.0',
    namespace: kubeSystemNamespace,
    fetchOpts: {
      repo: 'https://kubernetes-sigs.github.io/metrics-server/'
    },
    values: {}
  },
  {
    dependsOn: [cluster, aiSystemNs],
    provider: cluster.provider
  }
);

// Setup Kubernetes Autoscaler

const clusterOidcProvider = cluster.core.oidcProvider;
const clusterOidcProviderUrl = clusterOidcProvider.url;
const clusterOidcArn = clusterOidcProvider.arn;

const autoscalerAssumeRolePolicy = pulumi
  .all([clusterOidcProviderUrl, clusterOidcArn])
  .apply(([url, arn]) =>
    aws.iam.getPolicyDocument({
      statements: [
        {
          effect: 'Allow',
          principals: [
            {
              identifiers: [arn],
              type: 'Federated'
            }
          ],
          actions: ['sts:AssumeRoleWithWebIdentity'],
          conditions: [
            {
              test: 'StringEquals',
              values: [
                'system:serviceaccount:kube-system:autoscaler-aws-cluster-autoscaler'
              ],
              variable: `${url}:sub`
            }
          ]
        }
      ]
    })
  );

const autoscalerRole = new aws.iam.Role('cluster-autoscaler', {
  assumeRolePolicy: autoscalerAssumeRolePolicy.json
});

const autoscalerPolicy = new aws.iam.Policy('autoscaler-policy', {
  description: pulumi.interpolate`Autoscaler policy for ${cluster.eksCluster.id}`,
  policy: JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: [
          'autoscaling:DescribeAutoScalingGroups',
          'autoscaling:DescribeAutoScalingInstances',
          'autoscaling:DescribeLaunchConfigurations',
          'autoscaling:DescribeTags',
          'autoscaling:SetDesiredCapacity',
          'autoscaling:TerminateInstanceInAutoScalingGroup',
          'ec2:DescribeLaunchTemplateVersions'
        ],
        Resource: '*'
      }
    ]
  })
});

new aws.iam.RolePolicyAttachment('autoscaler-role-attach-policy', {
  policyArn: autoscalerPolicy.arn,
  role: autoscalerRole.name
});

const autoscaler = new k8s.helm.v3.Chart(
  'autoscaler',
  {
    namespace: kubeSystemNamespace,
    chart: 'cluster-autoscaler',
    fetchOpts: {
      repo: 'https://kubernetes.github.io/autoscaler'
    },
    version: '9.10.7',
    values: {
      cloudProvider: 'aws',
      rbac: {
        serviceAccount: {
          annotations: {
            'eks.amazonaws.com/role-arn': autoscalerRole.arn
          }
        }
      },
      awsRegion: config.get('aws.region'),
      autoDiscovery: {
        enabled: true,
        clusterName: cluster.eksCluster.name
      }
    }
  },
  {
    provider: cluster.provider,
    dependsOn: [cluster, metricsServerChart]
  }
);

// Setup Istio
const aiIstioNs = new k8s.core.v1.Namespace(
  'istio-system',
  { metadata: { name: 'istio-system' } },
  {
    provider: cluster.provider,
    dependsOn: [cluster, managedNodeGroup]
  }
);

const aiIstioIngressNs = new k8s.core.v1.Namespace(
  'istio-ingress',
  { metadata: { name: 'istio-ingress' } },
  {
    provider: cluster.provider,
    dependsOn: [cluster, managedNodeGroup]
  }
);

new k8s.rbac.v1.ClusterRoleBinding(
  'cluster-admin-binding',
  {
    metadata: { name: 'cluster-admin-binding' },
    roleRef: {
      apiGroup: 'rbac.authorization.k8s.io',
      kind: 'ClusterRole',
      name: 'cluster-admin'
    },
    subjects: [
      {
        apiGroup: 'rbac.authorization.k8s.io',
        kind: 'User',
        name: config.get('username') || 'admin'
      }
    ]
  },
  {
    dependsOn: [cluster],
    provider: cluster.provider
  }
);

const prometheus = new k8s.helm.v3.Release(
  'aisys-prometheus',
  {
    chart: 'prometheus',
    namespace: aiIstioNs.id,
    repositoryOpts: {
      repo: 'https://prometheus-community.github.io/helm-charts'
    },
    values: {},
  },
  {
    dependsOn: [aiIstioNs, cluster],
    provider: cluster.provider
  }
);

const grafana = new k8s.helm.v3.Release(
  'aisys-grafana',
  {
    chart: 'grafana',
    namespace: aiIstioNs.id,
    repositoryOpts: {
      repo: 'https://grafana.github.io/helm-charts'
    },
    values: {}
  },
  {
    dependsOn: [prometheus, aiIstioNs, cluster],
    provider: cluster.provider
  }
);

const istio = new k8s.helm.v3.Release(
  'aisys-istio',
  {
    chart: 'istio',
    version: '1.11.1',
    namespace: aiIstioNs.id,
    repositoryOpts: {
      repo: 'https://getindata.github.io/helm-charts/'
    },
    values: {}
  },
  {
    dependsOn: [aiIstioNs, cluster],
    provider: cluster.provider
  }
);

const kiali = new k8s.helm.v3.Release(
  'aisys-kiali',
  {
    chart: 'kiali-server',
    namespace: aiIstioNs.id,
    repositoryOpts: {
      repo: 'https://kiali.org/helm-charts/'
    },
    values: {}
  },
  {
    dependsOn: [istio, cluster],
    provider: cluster.provider
  }
);

//Put DB Secrets in Infra Namespace
const secretInfra = new kx.Secret(
  'aitomatic-infradb-secrets',
  {
    stringData: {
      'aitomatic-db-user': db.username,
      'aitomatic-db-password': db.password,
      'aitomatic-db-host': db.address,
      'aitomatic-db-port': db.port.apply((x) => `x`),
      'aitomatic-db-dbname': db.id
    },
    metadata: {
      namespace: aiInfraNs.id
    }
  },
  {
    dependsOn: [cluster],
    provider: cluster.provider
  }
);

//Put DB Secrets in Apps Namespace
const secretApps = new kx.Secret(
  'aitomatic-appsdb-secrets',
  {
    stringData: {
      'aitomatic-db-user': db.username,
      'aitomatic-db-password': db.password,
      'aitomatic-db-host': db.address,
      'aitomatic-db-port': db.port.apply((p) => `${p}`),
      'aitomatic-db-dbname': db.name
    },
    metadata: {
      namespace: aiAppsNs.id
    }
  },
  {
    dependsOn: [cluster],
    provider: cluster.provider
  }
);

// Install JenkinsX
const jxGitopNsName = 'jx-git-operator';

const jxGitopNs = new k8s.core.v1.Namespace(
  jxGitopNsName,
  { metadata: { name: jxGitopNsName } },
  {
    provider: cluster.provider,
    dependsOn: [cluster, managedNodeGroup]
  }
);

const jxgit = new k8s.helm.v3.Chart(  
  'jxgo',
  {
    chart: 'jx-git-operator',
    namespace: jxGitopNsName,
    fetchOpts: {
      repo: 'https://jenkins-x-charts.github.io/repo'
    },
    values: {
      url: config.get("jx.giturl"),
      username: config.get("jx.gitusername"),
      password: config.getSecret("jx.gittoken"),
    },
  },
  {
    dependsOn: [managedNodeGroup, cluster],
    provider: cluster.provider
  }
);

const seldonChart = new k8s.helm.v3.Release(
  'aiinfra-seldon',
  {
    chart: 'seldon-core-operator',
    version: '1.11',
    namespace: aiInfraNs.id,
    repositoryOpts: {
      repo: 'https://storage.googleapis.com/seldon-charts/'
    },
    values: {
      istio: {
        enabled: true,
        gateway: 'istio-ingressgateway'
      },
      ambassador: {
        enabled: false
      },
      usageMetrics: {
        enabled: true
      }
    }
  },
  {
    dependsOn: [cluster, istio, aiInfraNs],
    provider: cluster.provider
  }
);

// Install Spark Operator
const sparkOperatorRelease = new k8s.helm.v3.Chart(
  'spark-operator',
  {
    chart: 'spark-operator',
    version: '1.1.6',
    namespace: aiInfraNs.id,
    fetchOpts: {
      repo: 'https://googlecloudplatform.github.io/spark-on-k8s-operator'
    },
    values: {
      istio: {
        enabled: true
      },
      image: {
        tag: 'v1beta2-1.2.3-3.1.1'
      },
      sparkJobNamespace: aiAppsNs.id,
      serviceAccounts: {
        spark: {
          name: 'spark'
        },
        sparkoperator: {
          name: 'spark-operator'
        }
      }
    }
  },
  {
    dependsOn: [istio, cluster],
    provider: cluster.provider
  }
);
