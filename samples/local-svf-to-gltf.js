/*
 * Example: converting an SVF (without property database) from local file system.
 * Usage:
 *     node local-svf-to-gltf.js <path to svf file> <path to output folder>
 */

const path = require('path');
const { SVFReader, GLTFWriter } = require('..');

async function run(filepath, outputDir) {
    try {
        const reader = await SVFReader.FromFileSystem(filepath);
        const scene = await reader.read();
        let writer;
        writer = new GLTFWriter({ deduplicate: false, skipUnusedUvs: false, center: true, log: console.log });
        await writer.write(scene, path.join(outputDir, 'gltf-raw'));
        writer = new GLTFWriter({ deduplicate: true, skipUnusedUvs: true, center: true, log: console.log });
        await writer.write(scene, path.join(outputDir, 'gltf-dedup'));
    } catch(err) {
        console.error(err);
        process.exit(1);
    }
}

run(process.argv[2], process.argv[3]);
