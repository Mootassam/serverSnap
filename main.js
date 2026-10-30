'use strict';
// One code base, two apps:
//   ServerSnap         (admin: full control)     npm start
//   ServerSnap Client  (customer: download only) npm run client   /  --client
const path = require('path');
const fs = require('fs');

const client = process.argv.includes('--client') || process.env.SERVERSNAP_MODE === 'client' ||
  fs.existsSync(path.join(__dirname, 'client.flag'));

if (process.argv.includes('--uninstall')) require('./uninstall');
else require(client ? './client-main' : './admin-main');
