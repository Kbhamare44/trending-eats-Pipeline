/**
 * GET /api/version — which commit is actually serving.
 *
 * Exists so "is this stale code?" is answerable in one request instead of by
 * redeploying and hoping. Vercel injects the git SHA at build time.
 */
import { ok } from '@/lib/http/respond';

export async function GET() {
  return ok({
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'local',
    branch: process.env.VERCEL_GIT_COMMIT_REF ?? 'local',
    deployedAt: process.env.VERCEL_DEPLOYMENT_ID ? undefined : 'local dev',
    env: process.env.VERCEL_ENV ?? 'development',
    captionMetadataEnabled: (process.env.CAPTION_METADATA_ENABLED ?? (process.env.VERCEL_ENV === 'production' ? 'true' : 'false')) === 'true'
      && Boolean(process.env.SUPADATA_API_KEY),
  });
}
