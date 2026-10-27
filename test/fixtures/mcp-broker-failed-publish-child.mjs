import { realpathSync } from 'node:fs';
import { startBrokerApp } from './mcp-broker-app.js';

const userData = realpathSync(process.argv[2]);
let rejectedByFixture = false;
try {
  await startBrokerApp({ after() {} }, {
    userData,
    publishDescriptor: async () => {
      rejectedByFixture = true;
      throw new Error('SYNTHETIC_PUBLISH_REJECTED');
    }
  });
  throw new Error('PUBLISH_DID_NOT_REJECT');
} catch (error) {
  if (!rejectedByFixture || error.message !== 'SYNTHETIC_PUBLISH_REJECTED') {
    console.error(error);
    process.exitCode = 1;
  } else {
    console.log('PUBLISH_REJECTED_CLEANLY');
  }
}
