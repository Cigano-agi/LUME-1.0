import {neon} from '@neondatabase/serverless';
import {migrarCentral} from './central-migrations-lib.mjs';

if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL obrigatória. Nenhuma migração executada.');
const resultado=await migrarCentral({sql:neon(process.env.DATABASE_URL)});
console.log(`Migrações da central verificadas: ${resultado.total}; novas: ${resultado.novas}.`);
