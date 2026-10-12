import { createConfigService } from "../../config.service";

console.log(JSON.stringify(await createConfigService().read()));
