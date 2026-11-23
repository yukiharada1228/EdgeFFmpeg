/** Official Workers module declarations without installing its globals into Node. */
declare module 'cloudflare:workers' {
 import {CloudflareWorkersModule} from '@cloudflare/workers-types';
 export = CloudflareWorkersModule;
}
