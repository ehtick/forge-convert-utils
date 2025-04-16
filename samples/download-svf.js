/*
 * Example: downloading SVF assets for all viewables in a Model Derivative URN.
 * Usage:
 *     export APS_CLIENT_ID=<your client id>
 *     export APS_CLIENT_SECRET=<your client secret>
 *     export APS_REGION=<your region> # optional, can be one of the following: "US", "EMEA", "AUS"
 *     node download-svf.js <urn> <outputDir>
 */

const { SVFDownloader } = require('..');
const { initializeAuthenticationProvider } = require('./shared.js');

const [,, urn, outputDir] = process.argv;
if (!urn || !outputDir) {
    console.error('Usage: node download-svf.js <urn> <outputDir>');
    process.exit(1);
}

const authenticationProvider = initializeAuthenticationProvider();
const downloader = new SVFDownloader(authenticationProvider);
downloader.download(urn, { outputDir, log: console.log, region: process.env.APS_REGION })
    .then(() => console.log('Done!'))
    .catch(err => {
        console.error(err);
        process.exit(1);
    });