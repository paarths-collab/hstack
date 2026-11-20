"""Dependency-free backend contract regressions; native live acceptance is separate."""
import asyncio
from contextlib import contextmanager
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


class HTTPException(Exception):
    def __init__(self, status_code, detail):
        self.status_code, self.detail = status_code, detail


class Router:
    def post(self, path):
        return lambda func: func


sys.modules['fastapi'] = types.SimpleNamespace(APIRouter=Router, HTTPException=HTTPException, Request=object)
api = load('desktop_api_test', ROOT/'hermes-plugin/hstack-connections/dashboard/plugin_api.py')
probe = load('desktop_probe_test', ROOT/'hermes-plugin/hstack-connections/dashboard/native_probe.py')


class DesktopContracts(unittest.TestCase):
    def test_native_read_accepts_account_and_quota_blocks_but_rejects_errors(self):
        result = {'result': json.dumps({'id':'synthetic','organizations':[]})+'\n'+json.dumps({'rateLimit':[]})}
        stopped=[]
        core=types.SimpleNamespace(register_mcp_servers=lambda _: ['call'],mcp_prefixed_tool_name=lambda *_:'call',shutdown_mcp_servers=lambda:stopped.append(True))
        registry=types.SimpleNamespace(dispatch=lambda *_:json.dumps(result))
        with patch.dict(sys.modules,{'tools':types.SimpleNamespace(mcp_tool=core),'tools.registry':types.SimpleNamespace(registry=registry)}):
            self.assertEqual(probe.probe({'provider':'buffer','name':'fixture','config':{}})['state'],'used')
            result.clear();result['error']='synthetic error'
            with self.assertRaises(ValueError):probe.probe({'provider':'buffer','name':'fixture','config':{}})
        self.assertEqual(len(stopped),2)

    def test_activation_preserves_config_and_uses_profile_specific_state(self):
        self.check_activation_with_profile_layout(split=False)

    def test_activation_uses_split_native_profile_scope(self):
        self.check_activation_with_profile_layout(split=True)

    def test_activation_uses_config_backend_lock(self):
        self.check_activation_with_profile_layout(split=True, moved_lock=True)

    def check_activation_with_profile_layout(self, split, moved_lock=False):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);current=[root/'one']; entries={}; states={}; saved=[]
            mutation_lock = threading.RLock()
            @contextmanager
            def scope(profile):
                previous=current[0];current[0]=root/(profile or 'one')
                try:yield
                finally:current[0]=previous
            def save(name,config):
                self.assertTrue(mutation_lock._is_owned(), "Native shared lock must cover the save")
                entries.setdefault(str(current[0]),{})[name]=config;saved.append(name);return True
            def bridge(body,state_dir):
                key=(state_dir,body['provider'])
                if body['action']=='activate': states[key]='active'
                return {'state':states.get(key,'saved'),'message':'synthetic'}
            modules={'hermes_cli':types.ModuleType('hermes_cli'),
                     'hermes_cli.web_server':types.SimpleNamespace(_config_profile_scope=scope,_CONFIG_MUTATION_LOCK=mutation_lock),
                     'hermes_constants':types.SimpleNamespace(get_hermes_home=lambda:current[0]),
                     'hermes_cli.mcp_config':types.SimpleNamespace(_get_mcp_servers=lambda:entries.setdefault(str(current[0]),{}),_save_mcp_server=save)}
            if split:
                modules['hermes_cli.web_server_profiles'] = types.SimpleNamespace(_config_profile_scope=scope)
                del modules['hermes_cli.web_server']._config_profile_scope
            if moved_lock:
                modules['hermes_cli.config_backend'] = types.SimpleNamespace(CONFIG_MUTATION_LOCK=mutation_lock)
                del modules['hermes_cli.web_server']._CONFIG_MUTATION_LOCK
            with patch.dict(sys.modules,modules), patch.dict(api.os.environ,{'HSTACK_DESKTOP_PROJECT_ROOT':str(ROOT),'HSTACK_DESKTOP_NODE':sys.executable}), patch.object(api,'run_bridge',side_effect=bridge), patch.object(api,'use_native',return_value={'state':'used','message':'synthetic'}) as read:
                body={'action':'activate','provider':'buffer'}
                self.assertEqual(api.scoped_action(body,'one')['state'],'error')
                self.assertFalse(saved)
                states[(str(root/'one'/'hstack-connections'),'buffer')]='verified'
                entries[str(root/'one')]={'preserved':{'enabled':False}}
                self.assertEqual(api.scoped_action(body,'one')['state'],'active')
                self.assertEqual(api.scoped_action({'action':'use','provider':'buffer'},'one')['state'],'used')
                self.assertEqual(read.call_count,1)
                self.assertEqual(api.scoped_action({'action':'use','provider':'buffer'},'two')['state'],'error')
                self.assertEqual(read.call_count,1)
                self.assertEqual(len(entries[str(root/'one')]),2)
                entry=saved[0];entries[str(root/'one')][entry]={'command':'preserve-me'}
                self.assertEqual(api.scoped_action(body,'one')['state'],'error')
                self.assertEqual(entries[str(root/'one')][entry],{'command':'preserve-me'})

    def test_api_rejects_unknown_providers_and_never_echoes_secret_input(self):
        class Request:
            def __init__(self,body):self.value=body
            async def body(self):return self.value
        for provider,data in [('other',b'{}'),('buffer',b'{"key":123}'),('buffer',b'x'*8193),('buffer',b'{"action":"save","key":"secret","command":"bad"}')]:
            with self.assertRaises(HTTPException) as error:
                asyncio.run(api.provider_action(provider,Request(data)))
            self.assertNotIn('secret',error.exception.detail)


if __name__=='__main__':unittest.main()
