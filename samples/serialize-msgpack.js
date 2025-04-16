// Run `npm install msgpackr` first

const fs = require('fs');
const path = require('path');
const { pack } = require('msgpackr');
const { getSvfDerivatives } = require('./shared.js');
const { SVFReader, GLTFWriter, TwoLeggedAuthenticationProvider } = require('..');

class MsgpackGLTFWriter extends GLTFWriter {
    serializeManifest(manifest, outputPath) {
        // fs.writeFileSync(outputPath, JSON.stringify(manifest));
        fs.writeFileSync(outputPath + '.msgpack', pack(manifest));
    }
}

const { APS_CLIENT_ID, APS_CLIENT_SECRET, APS_REGION } = process.env;

async function run(urn, outputDir) {
    try {
        const derivatives = await getSvfDerivatives(urn, APS_CLIENT_ID, APS_CLIENT_SECRET, APS_REGION);
        const authenticationProvider = new TwoLeggedAuthenticationProvider(APS_CLIENT_ID, APS_CLIENT_SECRET);
        const writer = new MsgpackGLTFWriter({ deduplicate: true, center: true, log: console.log });
        for (const derivative of derivatives) {
            const reader = await SVFReader.FromDerivativeService(urn, derivative.guid, authenticationProvider);
            const scene = await reader.read({ log: console.log });
            await writer.write(scene, path.join(outputDir, derivative.guid));
        }
    } catch(err) {
        console.error(err);
        process.exit(1);
    }
}

run(process.argv[2], process.argv[3]);
