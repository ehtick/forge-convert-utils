import * as path from 'path';
import * as zlib from 'zlib';
import * as fse from 'fs-extra';
import axios from 'axios';
import { ManifestResources, ModelDerivativeClient, Region } from '@aps_sdk/model-derivative';
import { IAuthenticationProvider } from '../common/authentication-provider';
import { Scopes } from '@aps_sdk/authentication';
import { CancellationToken } from '../common/cancellation-token';

export interface IDownloadOptions {
    region?: Region;
    outputDir?: string;
    log?: (message: string) => void;
    failOnMissingAssets?: boolean;
    cancellationToken?: CancellationToken;
}

export class Downloader {
    protected readonly modelDerivativeClient = new ModelDerivativeClient();

    constructor(protected authenticationProvider: IAuthenticationProvider) { }

    async download(urn: string, options?: IDownloadOptions): Promise<void> {
        const outputDir = options?.outputDir || '.';
        const log = options?.log || ((message: string) => { });
        log(`Downloading derivative ${urn} (region: ${options?.region || 'default'})`);
        const accessToken = await this.authenticationProvider.getToken([Scopes.ViewablesRead]);
        const manifest = await this.modelDerivativeClient.getManifest(urn, { accessToken, region: options?.region });
        let derivatives: ManifestResources[] = [];
        function collectDerivatives(derivative: ManifestResources) {
            if (derivative.type === 'resource' && derivative.role === 'graphics' && (derivative as any).mime === 'application/autodesk-f2d') {
                derivatives.push(derivative);
            }
            if (derivative.children) {
                for (const child of derivative.children) {
                    collectDerivatives(child);
                }
            }
        }
        for (const derivative of manifest.derivatives) {
            if (derivative.children) {
                for (const child of derivative.children) {
                    collectDerivatives(child);
                }
            }
        }
        const urnDir = path.join(outputDir, urn);
        for (const derivative of derivatives) {
            if (options?.cancellationToken?.cancelled) {
                return;
            }
            const guid = derivative.guid;
            log(`Downloading viewable ${guid}`);
            const guidDir = path.join(urnDir, guid);
            fse.ensureDirSync(guidDir);
            const derivativeUrn = (derivative as any).urn;
            const baseUrn = derivativeUrn.substr(0, derivativeUrn.lastIndexOf('/'));
            const manifestGzip = await this.downloadDerivative(urn, baseUrn + '/manifest.json.gz', options?.region);
            fse.writeFileSync(path.join(guidDir, 'manifest.json.gz'), new Uint8Array(manifestGzip as Buffer));
            const manifestGunzip = zlib.gunzipSync(manifestGzip);
            const manifest = JSON.parse(manifestGunzip.toString());
            for (const asset of manifest.assets) {
                if (options?.cancellationToken?.cancelled) {
                    return;
                }
                log(`Downloading asset ${asset.URI}`);
                try {
                    const assetData = await this.downloadDerivative(urn, baseUrn + '/' + asset.URI, options?.region);
                    fse.writeFileSync(path.join(guidDir, asset.URI), new Uint8Array(assetData));
                } catch (err) {
                    if (options?.failOnMissingAssets) {
                        throw err;
                    } else {
                        log(`Could not download asset ${asset.URI}`);
                    }
                }
            }
        }
    }

    private async downloadDerivative(urn: string, derivativeUrn: string, region?: Region) {
        try {
            const accessToken = await this.authenticationProvider.getToken([Scopes.ViewablesRead]);
            const downloadInfo = await this.modelDerivativeClient.getDerivativeUrl(derivativeUrn, urn, { accessToken, region });
            const response = await axios.get(downloadInfo.url as string, { responseType: 'arraybuffer', decompress: false });
            return response.data;
        } catch (error) {
            if (axios.isAxiosError(error)) {
                throw new Error(`Could not download derivative ${derivativeUrn}: ${error.message}`);
            } else {
                throw error;
            }
        }
    }
}
