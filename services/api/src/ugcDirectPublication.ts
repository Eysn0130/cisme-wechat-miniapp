import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import sharp from "sharp";
import type { AppConfig } from "@cisme/config";
import { transaction, type DbClient } from "./db.js";
import type { ObjectStorage } from "./storage.js";

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

/** Only a current, explicit author publication intent may be completed by the scanner. */
export const directPublicationIntentSql = `EXISTS(SELECT 1 FROM audit_log intent
  WHERE intent.object_type='ugc_post' AND intent.object_id=p.id
    AND intent.action='ugc.post_submitted' AND intent.after_state->>'directPublication'='true'
    AND intent.after_state->>'newRevision'=p.current_revision::text)`;

export class UgcDirectPublication {
  constructor(private pool: pg.Pool, private config: AppConfig, private storage: ObjectStorage) {}

  private async gate(client: DbClient) {
    if (!this.config.ugcGoLiveGate) return false;
    const enabled = (await client.query("SELECT enabled FROM emergency_switch WHERE key='community' FOR SHARE")).rows[0]?.enabled;
    if (!enabled) return false;
    const approval = (await client.query(`SELECT expires_at FROM ugc_go_live_approval
      WHERE revoked_at IS NULL AND signed_at<=clock_timestamp() AND expires_at>clock_timestamp()
      ORDER BY expires_at DESC,id LIMIT 1 FOR SHARE`)).rows[0];
    return Boolean(approval && (await client.query("SELECT $1::timestamptz>clock_timestamp() AS valid", [approval.expires_at])).rows[0]?.valid);
  }

  async finish(postId: string) {
    return transaction(this.pool, async client => {
      const author = (await client.query("SELECT author_member_id FROM ugc_post WHERE id=$1", [postId])).rows[0]?.author_member_id;
      if (!author || !(await client.query("SELECT 1 FROM member WHERE id=$1 AND status='active' FOR SHARE", [author])).rowCount) return;
      const post = (await client.query(`SELECT p.*,r.title,r.body,r.moderation_state,r.public_consent_confirmed,
        ${directPublicationIntentSql} AS direct_publication
        FROM ugc_post p JOIN ugc_post_revision r ON r.post_id=p.id AND r.revision=p.current_revision
        WHERE p.id=$1 FOR UPDATE OF p`, [postId])).rows[0];
      if (!post || !post.direct_publication || !["pending_review", "published"].includes(post.state) ||
        post.current_revision === post.published_revision || post.moderation_state !== "pending" || !post.public_consent_confirmed) return;
      const assets = (await client.query(`SELECT a.* FROM ugc_post_media b JOIN ugc_media_asset a ON a.id=b.media_asset_id
        WHERE b.post_id=$1 AND b.revision=$2 ORDER BY a.id FOR UPDATE OF a`, [postId, post.current_revision])).rows;
      const text = [post.title, post.body].filter(Boolean).join("\n").trim();
      const textScan = text ? (await client.query(`SELECT state,content_sha256,provider FROM ugc_safety_scan
        WHERE post_id=$1 AND revision=$2 AND kind='text' ORDER BY requested_at DESC,id DESC LIMIT 1`, [postId, post.current_revision])).rows[0] : null;
      const scans = await Promise.all(assets.map(async asset => (await client.query(`SELECT state,content_sha256,provider,trace_id
        FROM ugc_safety_scan WHERE media_asset_id=$1 AND kind='image' ORDER BY requested_at DESC,id DESC LIMIT 1`, [asset.id])).rows[0]));
      const failed = (textScan && textScan.content_sha256 === digest(text) && ["risky", "review", "error"].includes(textScan.state)) ||
        scans.some((scan, i) => scan && scan.content_sha256 === assets[i].sha256 && ["risky", "review", "error"].includes(scan.state));
      if (failed) {
        await client.query("UPDATE ugc_post_revision SET moderation_state='rejected' WHERE post_id=$1 AND revision=$2", [postId, post.current_revision]);
        await client.query(`UPDATE ugc_post SET state=CASE WHEN published_revision IS NULL THEN 'rejected' ELSE 'published' END,
          version=version+1,updated_at=now() WHERE id=$1`, [postId]);
        await this.audit(client, postId, post.current_revision, "ugc.publication_failed", "AUTOMATIC_CHECK_FAILED");
        return;
      }
      if ((!text && !assets.length) || assets.length > 9 || (text && (!textScan || textScan.provider !== "wechat_v2" ||
        textScan.state !== "safe" || textScan.content_sha256 !== digest(text))) || assets.some((asset, i) =>
        asset.owner_member_id !== author || asset.source_post_id !== postId || asset.bound_post_id !== postId ||
        !["uploaded", "scanning", "approved"].includes(asset.state) || !scans[i] || scans[i].state !== "safe" ||
        scans[i].provider !== "wechat_v2" || scans[i].content_sha256 !== asset.sha256 || !scans[i].trace_id)) return;
      if (!await this.gate(client)) return;
      for (const [index, asset] of assets.entries()) {
        if (asset.state === "approved" && asset.public_object_key && asset.thumbnail_object_key) continue;
        const original = await this.storage.read(asset.object_key);
        if (digest(original.bytes) !== asset.sha256) return;
        const pipeline = sharp(Buffer.from(original.bytes), { limitInputPixels: 36_000_000 }).rotate();
        const detail = await pipeline.clone().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
        const thumbnail = await pipeline.clone().resize({ width: 480, height: 640, fit: "inside", withoutEnlargement: true }).webp({ quality: 76 }).toBuffer();
        const detailKey = `ugc-derived/${asset.id}/detail-${digest(detail)}.webp`, thumbnailKey = `ugc-derived/${asset.id}/thumb-${digest(thumbnail)}.webp`;
        await this.storage.writeDerivedImage(detailKey, detail);
        await this.storage.writeDerivedImage(thumbnailKey, thumbnail);
        await client.query(`UPDATE ugc_media_asset SET state='approved',public_object_key=$2,thumbnail_object_key=$3,
          scan_result=$4,derived_at=now(),updated_at=now() WHERE id=$1`, [asset.id, detailKey, thumbnailKey,
          {verdict:"safe",provider:"wechat_v2",traceId:scans[index].trace_id,checkedAt:new Date().toISOString()}]);
      }
      if (!await this.gate(client)) return;
      await client.query("UPDATE ugc_post_revision SET moderation_state='approved' WHERE post_id=$1 AND revision=$2", [postId, post.current_revision]);
      await client.query(`UPDATE ugc_post SET state='published',visibility='public',published_revision=current_revision,
        published_at=now(),version=version+1,updated_at=now() WHERE id=$1`, [postId]);
      await this.audit(client, postId, post.current_revision, "ugc.post_published", "AUTOMATIC_SAFETY_PASSED");
    });
  }

  private async audit(client: DbClient, id: string, revision: number, action: string, reason: string) {
    await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,after_state,trace_id)
      VALUES('system:ugc_safety',$1,'ugc_post',$2,$3,$4,$5)`, [action, id, reason, { revision, directPublication: true }, randomUUID()]);
  }
}
