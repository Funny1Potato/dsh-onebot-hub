/** 用 `--import` 挂载 `test/stub-hooks.mjs`（见该文件说明）。 */
import { register } from 'node:module';

register('./stub-hooks.mjs', import.meta.url);
