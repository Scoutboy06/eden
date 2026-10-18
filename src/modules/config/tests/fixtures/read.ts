import { createConfigService } from "../../config.service";

console.log(
  JSON.stringify(await createConfigService(undefined, { repositoryPath: process.argv[2] }).read()),
);
