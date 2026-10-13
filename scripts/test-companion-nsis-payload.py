import importlib.util
import pathlib
import unittest
spec=importlib.util.spec_from_file_location('payload',pathlib.Path(__file__).with_name('companion-verify-nsis-payload.py'))
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
class PayloadTests(unittest.TestCase):
    def test_exact_documented_patch(self):
        data=b'code'+p.UNKNOWN+b'resources'
        self.assertEqual(len(p.verify(data,data.replace(p.UNKNOWN,p.NSIS))),64)
    def test_unpatched_or_extra_changes_rejected(self):
        data=b'code'+p.UNKNOWN+b'resources'
        for value in [data,data.replace(p.UNKNOWN,p.NSIS)+b'changed',b'bad!'+p.NSIS+b'resources']:
            with self.assertRaises(ValueError):p.verify(data,value)
    def test_ambiguous_or_missing_marker_rejected(self):
        for value in [b'code',p.UNKNOWN+p.UNKNOWN]:
            with self.assertRaises(ValueError):p.verify(value,value)
if __name__=='__main__':unittest.main()
