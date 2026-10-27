import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
mkdirSync(root+'src/painel/vendor',{recursive:true});
copyFileSync(root+'node_modules/motion/dist/motion.js',root+'src/painel/vendor/motion.js');
copyFileSync(root+'node_modules/motion/LICENSE.md',root+'src/painel/vendor/motion-LICENSE.md');
console.log('Motion local copiado. Versão fixada em package-lock.json.');
