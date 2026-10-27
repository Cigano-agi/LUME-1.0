// Temporary, pinned rc14 compatibility patch based on WhiskeySockets/Baileys PR #2765.
// Remove when a published Baileys release includes companion_reg_refresh handling.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../node_modules/@whiskeysockets/baileys/', import.meta.url));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
if (version !== '7.0.0-rc14') throw new Error(`Unsupported Baileys version: ${version}`);

const utilPath = join(root, 'lib/Utils/companion-reg-client-utils.js');
const socketPath = join(root, 'lib/Socket/socket.js');
const ackPath = join(root, 'lib/Socket/messages-recv.js');
const util = readFileSync(utilPath, 'utf8');
const socket = readFileSync(socketPath, 'utf8');
const ack = readFileSync(ackPath, 'utf8');
const utilMarker = 'export const handleCompanionRegRefresh = ';
const socketMarker = "ws.on('CB:notification,type:companion_reg_refresh'";
const oldAck = 'buildAckStanza(node, errorCode, authState.creds.me.id)';
const newAck = 'buildAckStanza(node, errorCode, authState.creds.me?.id)';
const utilPatched = util.includes(utilMarker);
const socketPatched = socket.includes(socketMarker);
const ackPatched = ack.includes(newAck);
if (utilPatched && socketPatched && ackPatched) {
  process.stdout.write('Baileys companion refresh patch already present\n');
  process.exit(0);
}
if (!ackPatched && (!ack.includes(oldAck) || ack.split(oldAck).length !== 2)) {
  throw new Error('Baileys rc14 pre-login ACK layout changed; patch not applied');
}

const qrStart = '    // QR gen\n';
const qrEnd = '    // device paired for the first time\n';
const start = socket.indexOf(qrStart);
const end = socket.indexOf(qrEnd, start);
if (!socketPatched && (start < 0 || end < 0 || socket.indexOf(qrStart, start + 1) >= 0 ||
    !socket.slice(start, end).includes('const advB64 = creds.advSecretKey;') ||
    !socket.includes('buildPairingQRData, bytesToCrockford'))) {
  throw new Error('Baileys rc14 socket layout changed; patch not applied');
}
const utilEnd = '//# sourceMappingURL=companion-reg-client-utils.js.map';
if (!utilPatched && (!util.includes(utilEnd) || !util.includes('export const buildPairingQRData ='))) {
  throw new Error('Baileys rc14 utility layout changed; patch not applied');
}

const utilAddition = `import { randomBytes } from 'node:crypto';
import { getBinaryNodeChild } from '../WABinary/index.js';
`;
const utilFunctions = `
// Keep the current ref so a server-requested secret rotation does not spend another ref.
export const makePairingQRRenderer = (refs, render) => {
    let index = 0;
    let current;
    return {
        next() {
            const ref = refs[index];
            if (ref === undefined) return false;
            index++;
            current = ref;
            render(ref);
            return true;
        },
        refresh() {
            if (current === undefined) return false;
            render(current);
            return true;
        }
    };
};

export const handleCompanionRegRefresh = (node, { creds, emitCredsUpdate, refreshQR, logger }) => {
    const valid = ['companion_reg_refresh', 'pair-device-rotate-qr']
        .some(tag => getBinaryNodeChild(node, tag));
    if (!valid) {
        logger.warn('companion_reg_refresh without expected child; ignoring');
        return 'ignored_malformed';
    }
    // Pair-success and pairing-code flows both set me; rotating then would break auth.
    if (creds.me) {
        logger.debug('companion_reg_refresh after registration; ignoring');
        return 'ignored_registered';
    }
    creds.advSecretKey = randomBytes(32).toString('base64');
    emitCredsUpdate({ advSecretKey: creds.advSecretKey });
    logger.info('rotated companion registration secret; refreshed QR');
    refreshQR();
    return 'rotated';
};
`;
const nextUtil = utilPatched ? util : utilAddition + util.replace(utilEnd, utilFunctions + utilEnd);

const qrFlow = `    // QR gen: retain the current ref for server-requested secret rotation.
    let refreshPairingQR;
    ws.on('CB:iq,type:set,pair-device', async (stanza) => {
        const iq = {
            tag: 'iq',
            attrs: { to: S_WHATSAPP_NET, type: 'result', id: stanza.attrs.id }
        };
        await sendNode(iq);
        const pairDeviceNode = getBinaryNodeChild(stanza, 'pair-device');
        const refNodes = getBinaryNodeChildren(pairDeviceNode, 'ref');
        const noiseKeyB64 = Buffer.from(creds.noiseKey.public).toString('base64');
        const identityKeyB64 = Buffer.from(creds.signedIdentityKey.public).toString('base64');
        const renderer = makePairingQRRenderer(
            refNodes.map(refNode => refNode.content.toString('utf-8')),
            ref => ev.emit('connection.update', {
                qr: buildPairingQRData(ref, noiseKeyB64, identityKeyB64, creds.advSecretKey, browser)
            })
        );
        refreshPairingQR = () => void renderer.refresh();
        let qrMs = qrTimeout || 60000;
        const genPairQR = () => {
            if (!ws.isOpen) return;
            if (!renderer.next()) {
                void end(new Boom('QR refs attempts ended', { statusCode: DisconnectReason.timedOut }));
                return;
            }
            qrTimer = setTimeout(genPairQR, qrMs);
            qrMs = qrTimeout || 20000;
        };
        genPairQR();
    });
    ws.on('CB:notification,type:companion_reg_refresh', (node) => {
        handleCompanionRegRefresh(node, {
            creds,
            emitCredsUpdate: update => ev.emit('creds.update', update),
            refreshQR: () => refreshPairingQR?.(),
            logger
        });
    });
`;
// Recalculate offsets after the import change; do not rely on fixed byte positions.
const socketWithImport = socketPatched ? socket : socket.replace('buildPairingQRData, bytesToCrockford',
  'buildPairingQRData, handleCompanionRegRefresh, makePairingQRRenderer, bytesToCrockford');
const nextSocketContent = socketPatched ? socket : socketWithImport.replace(
  socketWithImport.slice(socketWithImport.indexOf(qrStart), socketWithImport.indexOf(qrEnd)), qrFlow);
if (!nextSocketContent.includes(socketMarker) || !nextUtil.includes(utilMarker)) {
  throw new Error('Baileys patch verification failed');
}
const replaceAtomically = (path, content) => {
  const temporary = `${path}.lume-patch-tmp`;
  writeFileSync(temporary, content);
  renameSync(temporary, path);
};
if (!utilPatched) replaceAtomically(utilPath, nextUtil);
if (!socketPatched) replaceAtomically(socketPath, nextSocketContent);
if (!ackPatched) replaceAtomically(ackPath, ack.replace(oldAck, newAck));
process.stdout.write('Patched Baileys 7.0.0-rc14 companion refresh\n');
