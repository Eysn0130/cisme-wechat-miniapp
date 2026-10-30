BEGIN;

ALTER TABLE daily_care_record
  ADD COLUMN care_day date,
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN latest_operation_id text,
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN superseded_by uuid,
  ADD CONSTRAINT daily_care_record_id_member_unique UNIQUE (id,member_id);

UPDATE daily_care_record SET care_day=(completed_at AT TIME ZONE 'Asia/Shanghai')::date,
  updated_at=completed_at,latest_operation_id=operation_id;
ALTER TABLE daily_care_record ALTER COLUMN care_day SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL,ALTER COLUMN latest_operation_id SET NOT NULL,
  ADD CONSTRAINT daily_care_record_latest_operation_check CHECK (length(latest_operation_id) BETWEEN 8 AND 200),
  ADD CONSTRAINT daily_care_record_superseded_other CHECK (superseded_by IS NULL OR superseded_by<>id);

-- Keep every original100 fact. Previously suppressed QA/privacy rows never
-- participate in choosing a current daily record and are never unsuppressed.
WITH selected AS (
  SELECT id,first_value(id) OVER (PARTITION BY member_id,care_day ORDER BY completed_at DESC,id DESC) AS winner
  FROM daily_care_record WHERE suppressed_at IS NULL
) UPDATE daily_care_record d SET superseded_by=s.winner FROM selected s WHERE d.id=s.id AND d.id<>s.winner;

CREATE UNIQUE INDEX daily_care_record_live_day ON daily_care_record(member_id,care_day)
  WHERE suppressed_at IS NULL AND deleted_at IS NULL AND superseded_by IS NULL;

CREATE TABLE daily_care_record_revision (
  record_id uuid NOT NULL,
  member_id uuid NOT NULL,
  version integer NOT NULL CHECK (version>0),
  action text NOT NULL CHECK (action IN ('baseline','create','update','delete','restore')),
  operation_id text NOT NULL CHECK (length(operation_id) BETWEEN 8 AND 200),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  source_fact jsonb NOT NULL CHECK (jsonb_typeof(source_fact)='object'),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY(record_id,version),
  UNIQUE(member_id,operation_id),
  FOREIGN KEY(record_id,member_id) REFERENCES daily_care_record(id,member_id) ON DELETE CASCADE
);

INSERT INTO daily_care_record_revision(record_id,member_id,version,action,operation_id,request_sha256,snapshot,source_fact,recorded_at)
SELECT id,member_id,version,'baseline',operation_id,request_sha256,
  jsonb_build_object('id',id,'source','daily','operationId',operation_id,
    'completedAt',to_char(completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'timezone',timezone,'protocolVersion',protocol_version,'stepCodes',step_codes,'selfAssessment',self_assessment,
    'careDay',care_day::text,'version',version,
    'updatedAt',to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'deleted',false),
  jsonb_build_object('id',id,'member_id',member_id,'operation_id',operation_id,'request_sha256',request_sha256,
    'completed_at',completed_at,'timezone',timezone,'protocol_version',protocol_version,
    'step_codes',step_codes,'self_assessment',self_assessment,'suppressed_at',suppressed_at),completed_at
FROM daily_care_record;

COMMIT;

-- migrate:down
BEGIN;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM daily_care_record_revision WHERE action<>'baseline') OR
     EXISTS(SELECT 1 FROM daily_care_record WHERE version<>1 OR deleted_at IS NOT NULL) OR
     EXISTS(SELECT 1 FROM daily_care_record d LEFT JOIN daily_care_record_revision r ON r.record_id=d.id AND r.version=1
       WHERE r.record_id IS NULL OR r.source_fact<>jsonb_build_object('id',d.id,'member_id',d.member_id,
         'operation_id',d.operation_id,'request_sha256',d.request_sha256,'completed_at',d.completed_at,
         'timezone',d.timezone,'protocol_version',d.protocol_version,'step_codes',d.step_codes,
         'self_assessment',d.self_assessment,'suppressed_at',d.suppressed_at)) THEN
    RAISE EXCEPTION 'DAILY_CARE_REVISIONS_EXIST: preserve facts, deletion and restore history';
  END IF;
END $$;
DROP TABLE daily_care_record_revision;
DROP INDEX daily_care_record_live_day;
ALTER TABLE daily_care_record DROP CONSTRAINT daily_care_record_id_member_unique,
  DROP COLUMN care_day,DROP COLUMN version,DROP COLUMN updated_at,DROP COLUMN latest_operation_id,
  DROP COLUMN deleted_at,DROP COLUMN superseded_by;
COMMIT;
