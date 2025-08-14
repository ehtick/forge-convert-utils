import * as path from 'node:path';
import * as fse from 'fs-extra';
import { IAuthenticationProvider } from '../common/authentication-provider';
import { ModelDataHttpClient } from './clients/ModelDataHttpClient';
import { SharedDataHttpClient } from './clients/SharedDataHttpClient';
import { SharedDataWebSocketClient, AssetType } from './clients/SharedDataWebSocketClient';
import { findManifestSVF2, resolveViewURN, OTGManifest } from './helpers/Manifest';
import { parseHashes } from './helpers/HashList';
import { getViewAccount, parse, resolveAssetUrn, resolveGeometryUrn, resolveMaterialUrn, resolveTextureUrn, View } from './helpers/View';
import { CancellationToken } from '../common/cancellation-token';

const UseWebSockets = true;
const BatchSize = 32;

export interface IDownloadOptions {
    outputDir?: string;
    log?: (message: string) => void;
    cancellationToken?: CancellationToken;
}

export class Downloader {
    protected readonly modelDataClient: ModelDataHttpClient;
    protected readonly sharedDataClient: SharedDataHttpClient;
    protected sharedDataWebSocketClient?: SharedDataWebSocketClient;

    constructor(protected readonly authenticationProvider: IAuthenticationProvider) {
        this.modelDataClient = new ModelDataHttpClient(authenticationProvider);
        this.sharedDataClient = new SharedDataHttpClient(authenticationProvider);
    }

    async download(urn: string, options?: IDownloadOptions): Promise<void> {
        const outputDir = options?.outputDir || '.';
        const log = options?.log || ((message: string) => { });
        log(`Downloading ${urn}...`);
        const urnDir = path.join(outputDir, urn);
        await fse.ensureDir(urnDir);
        const sharedAssetsDir = urnDir; // Update to store shared assets in the urn directory
        const derivativeManifest = await this.modelDataClient.getManifest(urn);
        await fse.writeFile(path.join(urnDir, 'manifest.json'), JSON.stringify(derivativeManifest, null, 2));
        const manifest = findManifestSVF2(derivativeManifest);
        this.sharedDataWebSocketClient = await SharedDataWebSocketClient.Connect(this.authenticationProvider);
        for (const [id, view] of Object.entries(manifest.views)) {
            if (options?.cancellationToken?.cancelled) {
                break;
            }
            if (view.role === 'graphics' && view.mime === 'application/autodesk-otg') {
                await this.downloadView(urn, manifest, id, path.join(urnDir, id), sharedAssetsDir, options);
            }
        }
        this.sharedDataWebSocketClient.close();
    }

    protected async downloadView(urn: string, manifest: OTGManifest, viewId: string, outputDir: string, sharedAssetsDir: string, options?: IDownloadOptions): Promise<void> {
        const log = options?.log || ((message: string) => { });
        log(`Downloading view ${viewId}...`);
        await fse.ensureDir(outputDir);
        const resolvedViewURN = resolveViewURN(manifest, manifest.views[viewId]);
        const viewManifestBuffer = await this.modelDataClient.getAsset(urn, encodeURIComponent(resolvedViewURN));
        const view = parse(JSON.parse(viewManifestBuffer.toString()));
        const viewFilePath = path.join(outputDir, manifest.views[viewId].urn);
        const viewFolderPath = path.dirname(viewFilePath);
        await fse.ensureDir(viewFolderPath);
        await fse.writeFile(viewFilePath, viewManifestBuffer);
        await this.downloadFragments(urn, resolvedViewURN, view, viewFolderPath, sharedAssetsDir, options);
        if (view.manifest.assets.geometry_ptrs) {
            if (UseWebSockets) {
                await this.downloadGeometriesBatch(urn, resolvedViewURN, view, viewFolderPath, sharedAssetsDir, options);
            } else {
                await this.downloadGeometries(urn, resolvedViewURN, view, viewFolderPath, sharedAssetsDir, options);
            }
        }
        if (view.manifest.assets.materials_ptrs) {
            if (UseWebSockets) {
                await this.downloadMaterialsBatch(urn, resolvedViewURN, view, viewFolderPath, sharedAssetsDir, options);
            } else {
                await this.downloadMaterials(urn, resolvedViewURN, view, viewFolderPath, sharedAssetsDir, options);
            }
        }
        await this.downloadTextures(urn, resolvedViewURN, view, viewFolderPath, sharedAssetsDir, options);
        await this.downloadProperties(urn, resolvedViewURN, view, viewFolderPath, sharedAssetsDir, options);
    }

    protected async downloadFragments(urn: string, resolvedViewURN: string, view: View, outputDir: string, sharedAssetsDir: string, options?: IDownloadOptions): Promise<void> {
        const log = options?.log || ((message: string) => { });
        log(`Downloading fragment list...`);
        const resolvedFragmentListUrn = resolveAssetUrn(resolvedViewURN, view.manifest.assets.fragments);
        const fragmentListBuffer = await this.modelDataClient.getAsset(urn, encodeURIComponent(resolvedFragmentListUrn));
        await fse.writeFile(path.join(outputDir, 'fragments.fl'), fragmentListBuffer);
    }

    protected async downloadGeometries(urn: string, resolvedViewURN: string, view: View, outputDir: string, sharedAssetsDir: string, options?: IDownloadOptions): Promise<void> {
        const log = options?.log || ((message: string) => { });
        log(`Downloading geometry list...`);
        const resolvedGeometryListUrn = resolveAssetUrn(resolvedViewURN, view.manifest.assets.geometry_ptrs!);
        const geometryListBuffer = await this.modelDataClient.getAsset(urn, encodeURIComponent(resolvedGeometryListUrn));
        await fse.writeFile(path.join(outputDir, 'geometry_ptrs.hl'), geometryListBuffer);
        const geometryFolderPath = path.join(sharedAssetsDir, view.manifest.shared_assets.geometry);
        await fse.ensureDir(geometryFolderPath);
        for (const hash of parseHashes(geometryListBuffer)) {
            if (options?.cancellationToken?.cancelled) {
                break;
            }
            const geometryFilePath = path.join(geometryFolderPath, hash);
            if (await fse.pathExists(geometryFilePath)) {
                log(`Geometry ${hash} already exists, skipping...`);
                continue;
            }
            log(`Downloading geometry ${hash}...`);
            const geometryUrn = resolveGeometryUrn(view, hash);
            const geometryBuffer = await this.sharedDataClient.getAsset(urn, geometryUrn);
            await fse.writeFile(geometryFilePath, geometryBuffer);
        }
    }

    protected async downloadGeometriesBatch(urn: string, resolvedViewURN: string, view: View, outputDir: string, sharedAssetsDir: string, options?: IDownloadOptions): Promise<void> {
        const log = options?.log || ((message: string) => { });
        log(`Downloading geometry list...`);
        const resolvedGeometryListUrn = resolveAssetUrn(resolvedViewURN, view.manifest.assets.geometry_ptrs!);
        const geometryListBuffer = await this.modelDataClient.getAsset(urn, encodeURIComponent(resolvedGeometryListUrn));
        await fse.writeFile(path.join(outputDir, 'geometry_ptrs.hl'), geometryListBuffer);
        const geometryFolderPath = path.join(sharedAssetsDir, view.manifest.shared_assets.geometry);
        await fse.ensureDir(geometryFolderPath);
        const account = getViewAccount(view);

        let batch: { hash: string; path: string; }[] = [];
        const processBatch = async () => {
            log(`Downloading geometry batch ${batch.map(e => e.hash.substring(0, 4))}...`);
            const buffers = await this.sharedDataWebSocketClient!.getAssets(urn, account, AssetType.Geometry, batch.map(e => e.hash));
            await Promise.all(batch.map(({ hash, path }) => fse.writeFile(path, buffers.get(hash)!)));
            batch = [];
        }

        for (const hash of parseHashes(geometryListBuffer)) {
            if (options?.cancellationToken?.cancelled) {
                break;
            }
            const geometryFilePath = path.join(geometryFolderPath, hash);
            if (await fse.pathExists(geometryFilePath)) {
                log(`Geometry ${hash} already exists, skipping...`);
                continue;
            }
            batch.push({ hash, path: geometryFilePath });
            if (batch.length === BatchSize) {
                await processBatch();
            }
        }
        if (batch.length > 0) {
            await processBatch();
        }
    }

    protected async downloadMaterials(urn: string, resolvedViewURN: string, view: View, outputDir: string, sharedAssetsDir: string, options?: IDownloadOptions): Promise<void> {
        const log = options?.log || ((message: string) => { });
        log(`Downloading material list...`);
        const resolvedMaterialListUrn = resolveAssetUrn(resolvedViewURN, view.manifest.assets.materials_ptrs!);
        const materialListBuffer = await this.modelDataClient.getAsset(urn, encodeURIComponent(resolvedMaterialListUrn));
        await fse.writeFile(path.join(outputDir, 'materials_ptrs.hl'), materialListBuffer);
        const materialFolderPath = path.join(sharedAssetsDir, view.manifest.shared_assets.materials);
        await fse.ensureDir(materialFolderPath);
        for (const hash of parseHashes(materialListBuffer)) {
            if (options?.cancellationToken?.cancelled) {
                break;
            }
            const materialFilePath = path.join(materialFolderPath, hash);
            if (await fse.pathExists(materialFilePath)) {
                log(`Material ${hash} already exists, skipping...`);
                continue;
            }
            log(`Downloading material ${hash}...`);
            const materialUrn = resolveMaterialUrn(view, hash);
            const materialBuffer = await this.sharedDataClient.getAsset(urn, materialUrn);
            await fse.writeFile(materialFilePath, materialBuffer);
        }
    }

    protected async downloadMaterialsBatch(urn: string, resolvedViewURN: string, view: View, outputDir: string, sharedAssetsDir: string, options?: IDownloadOptions): Promise<void> {
        const log = options?.log || ((message: string) => { });
        log(`Downloading material list...`);
        const resolvedMaterialListUrn = resolveAssetUrn(resolvedViewURN, view.manifest.assets.materials_ptrs!);
        const materialListBuffer = await this.modelDataClient.getAsset(urn, encodeURIComponent(resolvedMaterialListUrn));
        await fse.writeFile(path.join(outputDir, 'materials_ptrs.hl'), materialListBuffer);
        const materialFolderPath = path.join(sharedAssetsDir, view.manifest.shared_assets.materials);
        await fse.ensureDir(materialFolderPath);
        const account = getViewAccount(view);

        let batch: { hash: string; path: string }[] = [];
        const processBatch = async () => {
            log(`Downloading material batch ${batch.map(e => e.hash.substring(0, 4))}...`);
            const buffers = await this.sharedDataWebSocketClient!.getAssets(urn, account, AssetType.Material, batch.map(e => e.hash));
            await Promise.all(batch.map(({ hash, path }) => fse.writeFile(path, buffers.get(hash)!)));
            batch = [];
        }

        for (const hash of parseHashes(materialListBuffer)) {
            if (options?.cancellationToken?.cancelled) {
                break;
            }
            const materialFilePath = path.join(materialFolderPath, hash);
            if (await fse.pathExists(materialFilePath)) {
                log(`Material ${hash} already exists, skipping...`);
                continue;
            }
            batch.push({ hash, path: materialFilePath });
            if (batch.length === BatchSize) {
                await processBatch();
            }
        }
        if (batch.length > 0) {
            await processBatch();
        }
    }

    protected async downloadTextures(urn: string, resolvedViewUrn: string, view: View, outputDir: string, sharedAssetsDir: string, options?: IDownloadOptions): Promise<void> {
        if (!view.manifest.assets.texture_manifest) {
            return;
        }
        const log = options?.log || ((message: string) => { });
        log(`Downloading texture manifest...`);
        const resolvedTextureManifestUrn = resolveAssetUrn(resolvedViewUrn, view.manifest.assets.texture_manifest);
        const textureManifestBuffer = await this.modelDataClient.getAsset(urn, encodeURIComponent(resolvedTextureManifestUrn));
        await fse.writeFile(path.join(outputDir, 'texture_manifest.json'), textureManifestBuffer);
        const textureFolderPath = path.join(sharedAssetsDir, view.manifest.shared_assets.textures);
        await fse.ensureDir(textureFolderPath);
        const textureManifest = JSON.parse(textureManifestBuffer.toString()) as { [key: string]: string };
        for (const [_, uri] of Object.entries(textureManifest)) {
            if (options?.cancellationToken?.cancelled) {
                break;
            }
            const textureFilePath = path.join(textureFolderPath, uri);
            if (await fse.pathExists(textureFilePath)) {
                log(`Texture ${uri} already exists, skipping...`);
                continue;
            }
            log(`Downloading texture ${uri}...`);
            const textureUrn = resolveTextureUrn(view, uri);
            const textureBuffer = await this.sharedDataClient.getAsset(urn, textureUrn);
            await fse.writeFile(textureFilePath, textureBuffer);
        }
    }

    protected async downloadProperties(urn: string, resolvedViewURN: string, view: View, outputDir: string, sharedAssetsDir: string, options?: IDownloadOptions): Promise<void> {
        const log = options?.log || ((message: string) => { });
        log(`Downloading property assets...`);
        const write = async (uri?: string) => {
            if (uri) {
                log(`Downloading ${uri}...`);
                const resolvedAssetUrn = resolveAssetUrn(resolvedViewURN, uri);
                const buffer = await this.modelDataClient.getAsset(urn, encodeURIComponent(resolvedAssetUrn));
                const filePath = path.join(outputDir, uri);
                await fse.ensureDir(path.dirname(filePath));
                await fse.writeFile(filePath, buffer);
            }
        };
        const { avs, dbid, offsets } = view.manifest.assets.pdb;
        const { attrs, ids, values } = view.manifest.shared_assets.pdb;
        await Promise.all([
            write(avs),
            write(dbid),
            write(offsets),
            write(attrs),
            write(ids),
            write(values),
        ]);
    }
}