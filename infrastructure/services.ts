import { ITerraformDependable, TerraformAsset } from "cdktf";
import { Construct } from "constructs";
import * as fs from "fs";
import * as path from "path";
import { Deployment } from "./.gen/providers/kubernetes/deployment";
import { Service } from "./.gen/providers/kubernetes/service";
import { VERSION, DOCKER_ORG } from "./config";
import { Resource } from "./.gen/providers/null/resource";
import { Namespace } from "./.gen/providers/kubernetes/namespace";
import {
  DataGoogleServiceAccount,
  ServiceAccountKey,
} from "@cdktf/provider-google";

function buildAndPushImage(
  scope: Construct,
  imageName: string,
  p: string
): [string, Resource] {
  const _ = (name: string) => `${imageName}-${name}`;
  const files = fs.readdirSync(p);

  function getDockerfileFlag() {
    if (files.includes("Dockerfile")) {
      return "";
    }

    if (files.includes("package.json")) {
      const asset = new TerraformAsset(scope, _("node-dockerfile"), {
        path: path.resolve(__dirname, "Dockerfile.node"),
      });

      return `-f ${asset.path}`;
    }

    if (files.includes("Cargo.toml")) {
      const asset = new TerraformAsset(scope, _("node-dockerfile"), {
        path: path.resolve(__dirname, "Dockerfile.rust"),
      });

      return `-f ${asset.path}`;
    }

    throw new Error(
      "Unknown application language, please add a Dockerfile or use node or rust"
    );
  }

  function getVersion(): string {
    if (files.includes("package.json")) {
      return require(path.resolve(p, "package.json")).version;
    }

    return VERSION;
  }

  const dockerfileFlag = getDockerfileFlag();
  const content = new TerraformAsset(scope, _("content"), {
    path: p,
  });

  const sa = new DataGoogleServiceAccount(scope, _("sa"), {
    accountId: "registry-push",
  });

  const key = new ServiceAccountKey(scope, _("sa-key"), {
    serviceAccountId: sa.email,
  });

  const version = getVersion();
  

  const tag = `gcr.io/${DOCKER_ORG}/${imageName}:${version}-${content.assetHash}`;
  const image = new Resource(scope, _("image"), {
    triggers: {
      tag,
    },
  });
  

  const cmd = `echo '${key.privateKey}' | base64 -D | docker login -u _json_key --password-stdin https://gcr.io && docker build ${dockerfileFlag} -t ${tag} ${content.path} && docker push ${tag}`;
  image.addOverride("provisioner.local-exec.command", cmd);

  return [tag, image];
}

function service(
  scope: Construct,
  image: string,
  imageTag: string,
  ns: Namespace,
  dependencies: ITerraformDependable[]
) {
  const labels = { application: image };
  const deployment = new Deployment(scope, `${image}-deployment`, {
    dependsOn: dependencies,
    metadata: [
      {
        name: image,
        labels,
        namespace: ns.id,
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
                    image: imageTag,
                    port: [{ containerPort: 80 }],
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
    dependsOn: [...dependencies, deployment],
    metadata: [{ name: image, namespace: ns.id }],
    spec: [
      {
        selector: { application: image },
        port: [{ port: 80 }],
      },
    ],
  });
}

export function application(scope: Construct, p: string, ns: Namespace) {
  const name = path.basename(p);
  const [image, resource] = buildAndPushImage(scope, name, p);
  service(scope, name, image, ns, [ns, resource]);
}
