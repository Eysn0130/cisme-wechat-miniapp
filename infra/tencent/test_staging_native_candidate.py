"""Offline target refusals for the exact native-only staging candidate."""
import importlib.util,json,pathlib,unittest
from unittest.mock import Mock,patch
spec=importlib.util.spec_from_file_location('native_candidate',pathlib.Path(__file__).with_name('staging-candidate-native-only-20260922.py'))
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
class NativeCandidateGuards(unittest.TestCase):
    def setUp(self):
        self.config={'APP_ENV':'staging','DATABASE_URL':'postgres://cisme_staging:synthetic@127.0.0.1/cisme_accept_rc20260922_9ac72e41','OBJECT_STORAGE_DRIVER':'api_gateway'}
        self.old='37d3fdbe92006a42e6d3b9a037e4cec55e1f433f78d0ee404096fb57d72dfe4f'
    def test_production_host_cannot_pass_with_staging_label(self):
        with self.assertRaisesRegex(c.m.Refused,'STAGING_HOST_REQUIRED'):c.target('VM-0-10-ubuntu',self.config,self.old)
    def test_original_production_database_and_unknown_staging_database_refused(self):
        for db in ('cisme','cisme_test','cisme_staging','cisme_accept_rc20260922_unknown'):
            with self.subTest(db=db),self.assertRaisesRegex(c.m.Refused,'PREVIOUS_ISOLATED_STAGING'):
                c.target('VM-4-15-ubuntu',{**self.config,'DATABASE_URL':'postgres://cisme_staging@127.0.0.1/'+db},self.old)
    def test_artifact_drift_refused_before_reading_current_manifest(self):
        with self.assertRaisesRegex(c.m.Refused,'PREVIOUS_ARTIFACT_DRIFT'):c.target('VM-4-15-ubuntu',self.config,'0'*64)
    def test_actual_previous_source_and_path_are_both_required(self):
        current=Mock();manifest=Mock();current.__truediv__=Mock(return_value=manifest)
        manifest.read_text.return_value=json.dumps({'sourceHead':'0f1b4c346173ed26d6ffd3d6e3612ef893b14212'})
        current.resolve.return_value='/opt/cisme/releases/rc20260922-9ac72e41-0f1b4c346173'
        with patch.object(c.m,'CURRENT',current):
            c.target('VM-4-15-ubuntu',self.config,self.old)
            current.resolve.return_value='/opt/cisme/releases/unrelated'
            with self.assertRaisesRegex(c.m.Refused,'PREVIOUS_PATH_DRIFT'):c.target('VM-4-15-ubuntu',self.config,self.old)
            manifest.read_text.return_value=json.dumps({'sourceHead':'0'*40})
            with self.assertRaisesRegex(c.m.Refused,'PREVIOUS_SOURCE_DRIFT'):c.target('VM-4-15-ubuntu',self.config,self.old)
    def test_full_release_verifier_is_required_in_addition_to_file_hashes(self):
        with patch.object(c,'_original_verify'),patch.object(c.m,'run',return_value=json.dumps({'verified':False,'sourceHead':c.m.SOURCE})):
            with self.assertRaisesRegex(c.m.Refused,'FULL_ARTIFACT_REQUIRED'):c.full_verify(pathlib.Path('/synthetic'),{})
if __name__=='__main__':unittest.main()
