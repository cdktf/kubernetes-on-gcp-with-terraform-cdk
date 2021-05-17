import { Construct } from "constructs";
import * as fs from "fs";
import * as path from "path";
import { RegistryImage } from "./.gen/providers/docker/registry-image";
import { Deployment } from "./.gen/providers/kubernetes/deployment";
import { Service } from "./.gen/providers/kubernetes/service";
import { VERSION, NAMESPACE } from './config';



function buildAndPushImage(scope: Construct, image: string, p: string) {
  const files = fs.readdirSync(p);

  let dockerfile = `${p}/Dockerfile`;

  if (files.includes("package.json")) {
    dockerfile =  "Dockerfile.node";
  }

  if (files.includes("Cargo.toml")) {
    dockerfile =  "Dockerfile.rust";
  }

  return new RegistryImage(scope, `${image}-image`, {
    name: `${image}:${VERSION}`,
    buildAttribute: [
      {
        context: p,
        dockerfile,
      },
    ],
  });
}

function service(scope: Construct, image: string, resource: RegistryImage) {
  new Deployment(scope, `${image}-deployment`, {
    metadata: [
      {
        name: image,
        labels: { name: image },
        namespace: NAMESPACE,
      },
    ],
    spec: [
      {
        template: [
          {
            metadata: [
              {
                name: image,
                labels: { name: image },
                namespace: NAMESPACE,
              },
            ],
            spec: [
              {
                container: [{ name: "application", image: resource.name }],
              },
            ],
          },
        ],
      },
    ],
  });

  new Service(scope, `${image}-service`, {
    metadata: [{ name: image, namespace: NAMESPACE }],
    spec: [
      {
        selector: { application: image },
        port: [{ port: 80 }],
      },
    ],
  });
}

export function application(scope: Construct, p: string) {
  const name = path.basename(p);
  const imageResource = buildAndPushImage(scope, name, p);
  service(scope, name, imageResource);
}