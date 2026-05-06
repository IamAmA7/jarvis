/**
   * GET /api/cloud — list signed-in user's GCS-synced recordings.
   */
import { errorResponse, HttpError, json, requireUser } from '../_lib/auth';
import { admin } from '../_lib/supabase';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
    try {
          const { userId } = await requireUser(req);
          if (req.method !== 'GET') throw new HttpError(405, 'GET only');
          const { data, error } = await admin()
            .from('gcs_synced_files')
            .select('id,bucket,name,size_bytes,content_type,recorded_at,transcript_text,language,duration_sec,insights,status,error_message,processed_at')
            .eq('clerk_user_id', userId)
            .order('recorded_at', { ascending: false, nullsFirst: false })
            .limit(500);
          if (error) throw new HttpError(500, error.message);
          return json(200, { recordings: data ?? [] });
    } catch (err) {
          return errorResponse(err);
    }
}
