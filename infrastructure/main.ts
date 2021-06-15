import { Construct } from "constructs";
import { App, ITerraformDependable, TerraformStack } from "cdktf";
import { DockerProvider } from "./.gen/providers/docker/docker-provider";
import { KubernetesProvider } from "./.gen/providers/kubernetes/kubernetes-provider";
import * as fs from "fs";
import * as path from "path";
import { Namespace } from "./.gen/providers/kubernetes/namespace";
import { CLUSTER_NAME } from "./config";
import { buildAndPushImage } from "./docker";
import { TerraformGoogleModulesKubernetesEngineGoogleModulesAuth as GKEAuth } from "./.gen/modules/terraform-google-modules/kubernetes-engine/google/modules/auth";
import { HelmProvider } from "./.gen/providers/helm/helm-provider";
import { Release, ReleaseConfig } from "./.gen/providers/helm/release";
import { Resource } from "./.gen/providers/null/resource";
import { Deployment } from "./.gen/providers/kubernetes/deployment";
import { Service } from "./.gen/providers/kubernetes/service";
import {
  ContainerCluster,
  ContainerNodePool,
  ContainerRegistry,
  DataGoogleContainerCluster,
  GoogleProvider,
  ProjectIamMember,
  ServiceAccount,
} from "@cdktf/provider-google";

// https://developers.google.com/identity/protocols/oauth2/scopes
const oauthScopes = [
  "https://www.googleapis.com/auth/devstorage.read_only",
  "https://www.googleapis.com/auth/logging.write",
  "https://www.googleapis.com/auth/monitoring",
  "https://www.googleapis.com/auth/servicecontrol",
  "https://www.googleapis.com/auth/service.management.readonly",
  "https://www.googleapis.com/auth/trace.append",
  "https://www.googleapis.com/auth/cloud-platform",
];

class KubernetesService extends Resource {
  constructor(
    scope: Construct,
    namespace: Namespace,
    name: string,
    image: string,
    labels: Record<string, string>,
    dependencies: ITerraformDependable[]
  ) {
    super(scope, name);
    const deployment = new Deployment(scope, `${image}-deployment`, {
      dependsOn: dependencies,
      metadata: [
        {
          name,
          labels,
          namespace: namespace.id,
        },
      ],
      spec: [
        {
          selector: [
            {
              matchLabels: labels,
            },
          ],
          template: [
            {
              metadata: [
                {
                  labels,
                },
              ],
              spec: [
                {
                  container: [
                    {
                      name: "application",
                      image: image,
                      port: [{ containerPort: 80 }],
                      livenessProbe: [
                        {
                          httpGet: [
                            {
                              path: "/health",
                              port: "80",
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    new Service(scope, `${image}-service`, {
      dependsOn: [deployment],
      metadata: [{ name: image, namespace: namespace.id }],
      spec: [
        {
          selector: { application: image },
          port: [{ port: 80 }],
        },
      ],
    });
  }
}

class KubernetesCluster extends Resource {
  private sa: ServiceAccount;
  private cluster: ContainerCluster;

  constructor(scope: Construct, name: string, serviceAccount: ServiceAccount) {
    super(scope, name);

    this.sa = serviceAccount;
    this.cluster = new ContainerCluster(this, "cluster", {
      name,
      removeDefaultNodePool: true,
      initialNodeCount: 1,
      nodeConfig: [
        {
          preemptible: true,
          serviceAccount: this.sa.email,
          oauthScopes,
        },
      ],
    });
  }

  addNodePool(name: string, nodeCount = 3, machineType = "e2-medium") {
    new ContainerNodePool(this, name, {
      name,
      cluster: this.cluster.name,
      nodeCount,
      nodeConfig: [
        {
          preemptible: true,
          machineType,
          serviceAccount: this.sa.email,
          oauthScopes,
        },
      ],
    });
  }

  addAutoscalingNodePool(
    name: string,
    minNodeCount = 3,
    maxNodeCount = 10,
    machineType = "e2-medium"
  ) {
    new ContainerNodePool(this, name, {
      name,
      cluster: this.cluster.name,
      autoscaling: [
        {
          minNodeCount,
          maxNodeCount,
        },
      ],
      nodeConfig: [
        {
          preemptible: true,
          machineType,
          serviceAccount: this.sa.email,
          oauthScopes,
        },
      ],
    });
  }

  static onCluster(scope: Construct, name: string) {
    const cluster = new DataGoogleContainerCluster(scope, "cluster", {
      name,
    });

    const auth = new GKEAuth(scope, "auth", {
      clusterName: cluster.name,
      location: cluster.location,
      projectId: cluster.project,
    });

    new KubernetesProvider(scope, "kubernetes", {
      clusterCaCertificate: auth.clusterCaCertificateOutput,
      host: auth.hostOutput,
      token: auth.tokenOutput,
    });

    new HelmProvider(scope, "helm", {
      kubernetes: [
        {
          clusterCaCertificate: auth.clusterCaCertificateOutput,
          host: auth.hostOutput,
          token: auth.tokenOutput,
        },
      ],
    });

    return {
      installHelmChart(config: ReleaseConfig) {
        new Release(scope, config.name, config);
      },

      exposeDeployment(
        namespace: Namespace,
        name: string,
        image: string,
        labels: Record<string, string>,
        dependencies: ITerraformDependable[]
      ) {
        return new KubernetesService(
          scope,
          namespace,
          name,
          image,
          labels,
          dependencies
        );
      },
    };
  }
}

class InfrastructureLayer extends TerraformStack {
  constructor(scope: Construct, name: string) {
    super(scope, name);

    new GoogleProvider(this, "google", {
      zone: "us-central1-c",
      project: "dschmidt-cdk-test",
    });

    const sa = new ServiceAccount(this, "sa", {
      accountId: "cluster-admin",
      displayName: "Cluster Admin",
    });

    const pushSa = new ServiceAccount(this, "registry-push", {
      accountId: "registry-push",
      displayName: "RegistryPush",
    });

    new ProjectIamMember(this, "sa-role-binding", {
      role: "roles/storage.admin",
      member: `serviceAccount:${sa.email}`,
    });

    new ProjectIamMember(this, "push-role-binding", {
      role: "roles/storage.admin",
      member: `serviceAccount:${pushSa.email}`,
    });

    new ContainerRegistry(this, "registry", {});

    const cluster = new KubernetesCluster(this, CLUSTER_NAME, sa);
    cluster.addNodePool("main");
    cluster.addAutoscalingNodePool("workloads");
  }
}

class BaselineLayer extends TerraformStack {
  constructor(scope: Construct, name: string) {
    super(scope, name);
    new GoogleProvider(this, "google", {
      zone: "us-central1-c",
      project: "dschmidt-cdk-test",
    });

    const cluster = KubernetesCluster.onCluster(this, CLUSTER_NAME);
    cluster.installHelmChart({
      name: "cert-manager",
      repository: "https://charts.jetstack.io",
      chart: "cert-manager",
      createNamespace: true,
      namespace: "cert-manager",
      version: "v1.3.1",
    });
  }
}

class ApplicationLayer extends TerraformStack {
  constructor(scope: Construct, name: string) {
    super(scope, name);
    new GoogleProvider(this, "google", {
      zone: "us-central1-c",
      project: "dschmidt-cdk-test",
    });
    new DockerProvider(this, "docker", {});
    const cluster = KubernetesCluster.onCluster(this, CLUSTER_NAME);

    const ns = new Namespace(this, "ns", {
      metadata: [
        {
          name,
        },
      ],
    });

    const servicePath = path.resolve(__dirname, "../services");
    fs.readdirSync(servicePath).forEach((p) => {
      const [tag, image] = buildAndPushImage(
        this,
        p,
        path.resolve(servicePath, p)
      );
      cluster.exposeDeployment(
        ns,
        p,
        tag,
        {
          application: p,
        },
        [image]
      );
    });
  }
}

const app = new App();
new InfrastructureLayer(app, "infrastructure");
new BaselineLayer(app, "baseline");
new ApplicationLayer(app, "development");
new ApplicationLayer(app, "staging");
new ApplicationLayer(app, "production");
app.synth();
