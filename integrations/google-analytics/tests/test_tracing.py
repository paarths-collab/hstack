"""Run with the pinned vendor interpreter; no network exporters or models."""
import importlib.metadata
import subprocess
import sys
import unittest


class TracingCompatibilityTests(unittest.TestCase):
    def test_patched_versions_and_valid_trace_state(self):
        from opentelemetry.trace import TraceState
        self.assertEqual(importlib.metadata.version("opentelemetry-api"), "1.45.1")
        self.assertEqual(importlib.metadata.version("opentelemetry-sdk"), "1.45.1")
        state = TraceState.from_header(["vendor=value, other=second"])
        self.assertEqual(dict(state.items()), {"vendor": "value", "other": "second"})

    def test_oversized_malformed_trace_state_finishes_within_a_bound(self):
        code = "from opentelemetry.trace import TraceState; assert not dict(TraceState.from_header(['a=b'+'\\t'*100_000+'x']).items())"
        result = subprocess.run([sys.executable, "-I", "-c", code], timeout=3, capture_output=True)
        self.assertEqual(result.returncode, 0)

    def test_sdk_exports_local_spans_without_a_network_exporter(self):
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import SimpleSpanProcessor
        from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
        exporter = InMemorySpanExporter()
        provider = TracerProvider()
        provider.add_span_processor(SimpleSpanProcessor(exporter))
        try:
            with provider.get_tracer("hstack.compatibility").start_as_current_span("synthetic") as span:
                span.set_attribute("synthetic", True)
            spans = exporter.get_finished_spans()
            self.assertEqual(len(spans), 1)
            self.assertEqual(spans[0].attributes["synthetic"], True)
        finally:
            provider.shutdown()


if __name__ == "__main__":
    unittest.main()
