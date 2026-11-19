"""Make the wheel platform-specific because it bundles a native UniFFI library."""

import os
import sysconfig

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class NativeWheelHook(BuildHookInterface):
    """Emit a platform wheel instead of an incorrect py3-none-any wheel."""

    def initialize(self, version: str, build_data: dict[str, object]) -> None:
        build_data["pure_python"] = False
        platform = os.environ.get("RYU_PYTHON_PLATFORM_TAG") or sysconfig.get_platform()
        platform = platform.replace("-", "_").replace(".", "_")
        build_data["tag"] = f"py3-none-{platform}"
