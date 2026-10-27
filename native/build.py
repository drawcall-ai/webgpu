"""Build the host's Vulkan Dawn binding: python native/build.py BUILD_DIR OUTPUT_DIR."""
import argparse
import hashlib
import json
import platform
import shutil
import subprocess
from pathlib import Path

from patch import patch

DAWN = "77f9a9aa5f7180958480de17680c61a84c006842"
GPUWEB = "22507c95ccb9e705eddc7cab8f28aa46b134f5fe"
HEADERS = "d5cfe19da8b974ca35764dd1c73b91d57cd3c4ce"
ADDON = "1e26dcb52829a74260ec262edb41fc22998669b6"


def run(*args):
    subprocess.run([str(arg) for arg in args], check=True)


def fetch_archive(repository, commit, destination, cache):
    stamp = destination / ".drawcall-commit"
    if stamp.exists() and stamp.read_text() == commit:
        return
    archive = cache / (repository.replace("/", "-") + ".tar.gz")
    run("curl", "-fL", "--retry", "3", f"https://codeload.github.com/{repository}/tar.gz/{commit}", "-o", archive)
    staging = destination.with_name(destination.name + ".extracting")
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    run("tar", "-xzf", archive, "--strip-components=1", "-C", staging)
    (staging / ".drawcall-commit").write_text(commit)
    if destination.exists():
        shutil.rmtree(destination)
    staging.rename(destination)


def target():
    systems = {"Linux": "linux", "Darwin": "darwin", "Windows": "win32"}
    architectures = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}
    system = systems.get(platform.system())
    if system == "linux" and list(Path("/lib").glob("ld-musl-*.so.1")):
        system = "linuxmusl"
    architecture = architectures.get(platform.machine().lower())
    name = f"{system}-{architecture}"
    if name not in {"linux-x64", "linux-arm64", "linuxmusl-x64", "linuxmusl-arm64",
                    "darwin-x64", "darwin-arm64", "win32-x64", "win32-arm64"}:
        raise RuntimeError(f"Unsupported build host: {platform.system()} {platform.machine()}")
    return name


def build_loader(source, work, output, host, jobs):
    if host == "win32-arm64":
        # The pinned loader's ARM assembly contains C directives; armasm64 needs preprocessed input.
        cmake = source / "third_party/vulkan-loader/src/loader/CMakeLists.txt"
        original = cmake.with_suffix(".txt.platform-original")
        if not original.exists():
            original.write_bytes(cmake.read_bytes())
        contents = original.read_text()
        anchor = "            list(APPEND OPT_LOADER_SRCS unknown_ext_chain_marmasm.asm)"
        if contents.count(anchor) != 1:
            raise RuntimeError("Vulkan loader ARM preprocessing patch anchor must occur exactly once")
        contents = contents.replace(anchor, """            set(ARM_ASSEMBLY ${CMAKE_CURRENT_BINARY_DIR}/unknown_ext_chain_preprocessed.asm)
            add_custom_command(OUTPUT ${ARM_ASSEMBLY}
                COMMAND ${CMAKE_C_COMPILER} /nologo /P /EP /TC /Fi${ARM_ASSEMBLY}
                    ${CMAKE_CURRENT_SOURCE_DIR}/unknown_ext_chain_marmasm.asm
                DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/unknown_ext_chain_marmasm.asm
                VERBATIM)
            list(APPEND OPT_LOADER_SRCS ${ARM_ASSEMBLY})""")
        if cmake.read_text() != contents:
            cmake.write_text(contents)
    prefix = work / "vulkan-headers"
    run("cmake", "-S", source / "third_party/vulkan-headers/src", "-B", work / "headers-build",
        "-G", "Ninja", f"-DCMAKE_INSTALL_PREFIX={prefix}", "-DVULKAN_HEADERS_ENABLE_TESTS=OFF",
        "-DVULKAN_HEADERS_ENABLE_MODULE=OFF")
    run("cmake", "--install", work / "headers-build")
    options = []
    if host.startswith(("linux-", "linuxmusl-")):
        options = [f"-DBUILD_WSI_{surface}_SUPPORT=OFF" for surface in
                   ("XCB", "XLIB", "XLIB_XRANDR", "WAYLAND", "DIRECTFB")]
    elif host.startswith("darwin-"):
        options = ["-DCMAKE_OSX_DEPLOYMENT_TARGET=13.5"]
    else:
        options = ["-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded"]
    run("cmake", "-S", source / "third_party/vulkan-loader/src", "-B", work / "loader-build",
        "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release", f"-DCMAKE_PREFIX_PATH={prefix}",
        "-DBUILD_TESTS=OFF", *options)
    run("cmake", "--build", work / "loader-build", "--target", "vulkan", "--parallel", jobs)
    name = {"Linux": "libvulkan.so.1", "Darwin": "libvulkan.dylib",
            "Windows": "vulkan-1.dll"}[platform.system()]
    libraries = list((work / "loader-build").rglob(name))
    if len(libraries) != 1:
        raise RuntimeError(f"Expected one Vulkan loader, got {libraries}")
    shutil.copy2(libraries[0], output / name)


def build(work, output, jobs=4):
    host = target()
    if jobs < 1:
        raise ValueError("Build jobs must be positive")
    work.mkdir(parents=True, exist_ok=True)
    output.mkdir(parents=True, exist_ok=True)
    source = work / "dawn"
    fetch_archive("google/dawn", DAWN, source, work)
    fetch_archive("nodejs/node-api-headers", HEADERS, source / "third_party/node-api-headers", work)
    fetch_archive("nodejs/node-addon-api", ADDON, source / "third_party/node-addon-api", work)
    idl = source / "third_party/gpuweb/webgpu.idl"
    idl.parent.mkdir(exist_ok=True)
    run("curl", "-fL", "--retry", "3", f"https://raw.githubusercontent.com/gpuweb/gpuweb/{GPUWEB}/webgpu.idl", "-o", idl)
    patch(source, musl=host.startswith("linuxmusl-"))
    options = ["-DDAWN_ENABLE_SWIFTSHADER=OFF"]
    if host.startswith(("linux-", "linuxmusl-")):
        options.append("-DCMAKE_SHARED_LINKER_FLAGS=-static-libstdc++ -static-libgcc -Wl,--exclude-libs,ALL")
    if host.startswith("darwin-"):
        options.append("-DCMAKE_OSX_DEPLOYMENT_TARGET=13.5")
    if host.startswith("win32-"):
        options.extend(["-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded", "-DABSL_MSVC_STATIC_RUNTIME=ON"])
    run("cmake", "-S", source, "-B", work / "build", "-G", "Ninja",
        "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_CXX_VISIBILITY_PRESET=hidden",
        "-DCMAKE_VISIBILITY_INLINES_HIDDEN=1", "-DDAWN_BUILD_NODE_BINDINGS=ON",
        "-DDAWN_FETCH_DEPENDENCIES=ON", "-DDAWN_USE_X11=OFF", "-DDAWN_USE_WAYLAND=OFF",
        "-DDAWN_USE_WINDOWS_UI=OFF", "-DDAWN_ENABLE_VULKAN=ON",
        "-DDAWN_ENABLE_METAL=OFF", "-DDAWN_ENABLE_D3D11=OFF", "-DDAWN_ENABLE_D3D12=OFF",
        "-DDAWN_ENABLE_NULL=OFF",
        "-DDAWN_BUILD_SAMPLES=OFF", "-DDAWN_BUILD_TESTS=OFF", "-DTINT_BUILD_TESTS=OFF",
        "-DDAWN_ENABLE_OPENGLES=OFF", "-DDAWN_ENABLE_DESKTOP_GL=OFF", "-DDAWN_SUPPORTS_CXX_MODULES=OFF",
        *options)
    run("cmake", "--build", work / "build", "--target", "dawn_node", "--parallel", jobs)
    binaries = list((work / "build").rglob("dawn.node"))
    if len(binaries) != 1:
        raise RuntimeError(f"Expected one Dawn binary, got {binaries}")
    shutil.copy2(binaries[0], output / "dawn.node")
    build_loader(source, work, output, host, jobs)
    manifest = {"target": host, "driver": "mesa", "dawn": DAWN, "gpuweb": GPUWEB, "nodeApiHeaders": HEADERS, "nodeAddonApi": ADDON,
                "sha256": hashlib.sha256((output / "dawn.node").read_bytes()).hexdigest(),
                "sources": {f"native/{p.name}": hashlib.sha256(p.read_bytes()).hexdigest()
                          for p in (Path(__file__).parent / name for name in
                                    ("build.py", "patch.py", "bitmap.h", "factory.cpp", "queue.cpp", "driver.cpp"))}}
    manifest["libraries"] = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in output.iterdir()
                             if p.suffix in {".node", ".dll", ".dylib", ".so"} or p.name.endswith(".so.1")}
    (output / "build.json").write_text(json.dumps(manifest, indent=2) + "\n")
    # Preserve dependency notices from the exact source tree CMake fetched.
    licenses = [p for p in source.rglob("*") if p.is_file()
                and (p.name.upper().startswith("LICENSE") or p.name.upper().startswith("COPYING") or p.name.upper().startswith("NOTICE"))
                and p.suffix not in (".py", ".go", ".json", ".h", ".cc")]
    with (output / "DAWN_NOTICES").open("w", encoding="utf-8") as notices:
        for path in sorted(licenses):
            notices.write(f"\n{'=' * 72}\n{path.relative_to(source)}\n\n")
            notices.write(path.read_text(encoding="utf-8", errors="replace"))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("work", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--jobs", type=int, default=4)
    args = parser.parse_args()
    build(args.work.resolve(), args.output.resolve(), args.jobs)
