import {CISME_OFFICIAL_PUBLISHER} from '@cisme/contracts';

// Public identity is separate from source-member attribution and audit actors.
// This UUID belongs to the publisher namespace; it is never inserted in member.
export const officialPublisher=CISME_OFFICIAL_PUBLISHER;
export const editorialPublicAuthorIdSql=`CASE WHEN a.publisher_id='${officialPublisher.key}'
  THEN '${officialPublisher.id}'::uuid ELSE a.author_member_id END`;
export function editorialPublicAuthorId(article:{publisher_id:string|null;author_member_id:string}){
  return article.publisher_id===officialPublisher.key?officialPublisher.id:article.author_member_id;
}
