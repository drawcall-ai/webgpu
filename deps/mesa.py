"""Build portable lavapipe from pinned sources for the host platform."""
import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
from pathlib import Path

SOURCES = {
    "llvm": (
        "https://github.com/llvm/llvm-project/releases/download/llvmorg-19.1.7/llvm-project-19.1.7.src.tar.xz",
        "82401fea7b79d0078043f7598b835284d6650a75b93e64b6f761ea7b63097501",
    ),
    "glslang": (
        "https://codeload.github.com/KhronosGroup/glslang/tar.gz/1062752a891c95b2bfeed9e356562d88f9df84ac",
        "46a05bba7675a3ab1912a0908183b9eee8daa06bb8047943bac54a6f0de2cfce",
    ),
    "directx": (
        "https://codeload.github.com/microsoft/DirectX-Headers/tar.gz/48a762973271c5a75869946bf1fdbc489a628a5c",
        "7ee27f7662858719074b6a0a3ac91336e7645c4e255c29f33cc4335ee36fa51c",
    ),
    "libdrm": (
        "https://dri.freedesktop.org/libdrm/libdrm-2.4.124.tar.xz",
        "ac36293f61ca4aafaf4b16a2a7afff312aa4f5c37c9fbd797de9e3c0863ca379",
    ),
    "mesa": (
        "https://archive.mesa3d.org/mesa-25.0.7.tar.xz",
        "592272df3cf01e85e7db300c449df5061092574d099da275d19e97ef0510f8a6",
    ),
}


def run(*args, cwd=None):
    subprocess.run([str(arg) for arg in args], check=True, cwd=cwd)


def fetch(name, work):
    url, checksum = SOURCES[name]
    destination = work / name
    stamp = destination / ".drawcall-source"
    if stamp.exists() and stamp.read_text() == checksum:
        return destination
    archive = work / f"{name}.tar"
    run("curl", "-fL", "--retry", "3", url, "-o", archive)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != checksum:
        raise RuntimeError(f"{name} source checksum mismatch")
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir()
    members = [f"llvm-project-19.1.7.src/{component}" for component in
               ("llvm", "cmake", "third-party", "libc")] if name == "llvm" else []
    tar = "tar"
    options = []
    if platform.system() == "Windows":
        git = Path(subprocess.check_output(["git", "--exec-path"], text=True).strip())
        candidates = [parent / "usr/bin/tar.exe" for parent in git.parents]
        tar = next((path for path in candidates if path.is_file()), None)
        if tar is None:
            raise RuntimeError("Git for Windows GNU tar is required to extract LLVM")
        options = ["--force-local"]
    run(tar, *options, "-xf", archive.name, "--strip-components=1", "-C", destination.name, *members, cwd=work)
    archive.unlink()
    stamp.write_text(checksum)
    return destination


def cmake(source, build, prefix, jobs, options, targets):
    run("cmake", "-S", source, "-B", build, "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release",
        f"-DCMAKE_INSTALL_PREFIX={prefix}", "-DCMAKE_POSITION_INDEPENDENT_CODE=ON", *options)
    run("cmake", "--build", build, "--parallel", jobs, "--target", *targets)


def meson(source, build, prefix, jobs, options):
    reconfigure = ["--reconfigure"] if (build / "meson-private/coredata.dat").exists() else []
    run("meson", "setup", *reconfigure, build, source, f"--prefix={prefix}", "--libdir=lib",
        "--buildtype=release", "-Db_ndebug=true", *options)
    run("ninja", "-C", build, "-j", jobs, "install")


def replace(path, replacements):
    original = path.with_suffix(path.suffix + ".platform-original")
    if not original.exists():
        original.write_bytes(path.read_bytes())
    contents = original.read_text()
    for old, new in replacements.items():
        if contents.count(old) != 1:
            raise RuntimeError(f"Patch anchor must occur exactly once in {path}: {old}")
        contents = contents.replace(old, new)
    if path.read_text() != contents:
        path.write_text(contents)


def patch(sources, host):
    replace(sources["mesa"] / "src/gallium/auxiliary/gallivm/lp_bld_misc.cpp", {
        "#include <llvm/Target/TargetOptions.h>":
            "#include <llvm/Target/TargetOptions.h>\n#include <llvm/Target/TargetMachine.h>",
        "   JIT = builder.create();": """#if DETECT_ARCH_AARCH64
   // JIT code and constants can lie beyond ADRP's range (e.g. across V8's address reservation).
   // LLVM 19 GlobalISel ignores Large for constant pools; SelectionDAG handles full addresses.
   builder.setCodeModel(CodeModel::Large);
   TargetMachine *target = builder.selectTarget();
   if (target)
      target->setGlobalISel(false);
   JIT = builder.create(target);
#else
   JIT = builder.create();
#endif""",
    })
    if host == "Windows":
        # Mesa's Windows MCJIT uses ELF, which supports the absolute relocations needed by Large.
        replace(sources["llvm"] / "llvm/lib/Target/AArch64/AArch64TargetMachine.cpp", {
            "  // AArch64 Darwin and Windows are always PIC.\n  if (TT.isOSDarwin() || TT.isOSWindows())":
                "  // Darwin and Windows COFF require PIC; ELF MCJIT can use absolute addresses.\n"
                "  if (TT.isOSDarwin() || (TT.isOSWindows() && !TT.isOSBinFormatELF()))",
        })

        replace(sources["llvm"] / "llvm/lib/Target/AArch64/AArch64FrameLowering.cpp", {
            '''      BuildMI(MBB, MBBI, DL, TII->get(AArch64::MOVaddrEXT))
          .addReg(AArch64::X16, RegState::Define)
          .addExternalSymbol(ChkStk)
          .addExternalSymbol(ChkStk)
          .setMIFlags(MachineInstr::FrameSetup);''':
                '''      if (Subtarget.isTargetELF()) {
        // Large ELF cannot address __chkstk with the ADRP+ADD used by COFF.
        const unsigned Flags[] = {AArch64II::MO_G0 | AArch64II::MO_NC,
                                  AArch64II::MO_G1 | AArch64II::MO_NC,
                                  AArch64II::MO_G2 | AArch64II::MO_NC,
                                  AArch64II::MO_G3};
        for (unsigned I = 0; I != 4; ++I) {
          auto MIB = BuildMI(MBB, MBBI, DL,
                             TII->get(I == 0 ? AArch64::MOVZXi : AArch64::MOVKXi),
                             AArch64::X16);
          if (I != 0)
            MIB.addReg(AArch64::X16);
          MIB.addExternalSymbol(ChkStk, Flags[I])
              .addImm(I * 16)
              .setMIFlags(MachineInstr::FrameSetup);
          // The existing post-sequence SEH_Nop accounts for the final move.
          if (NeedsWinCFI && I != 3)
            BuildMI(MBB, MBBI, DL, TII->get(AArch64::SEH_Nop))
                .setMIFlag(MachineInstr::FrameSetup);
        }
      } else {
        BuildMI(MBB, MBBI, DL, TII->get(AArch64::MOVaddrEXT))
            .addReg(AArch64::X16, RegState::Define)
            .addExternalSymbol(ChkStk)
            .addExternalSymbol(ChkStk)
            .setMIFlags(MachineInstr::FrameSetup);
      }''',
        })



def notices(sources, output):
    with (output / "MESA_NOTICES").open("w", encoding="utf-8") as stream:
        for source in sources:
            for path in sorted(source.rglob("*")):
                if not path.is_file() or not path.name.upper().startswith(("LICENSE", "COPYING", "NOTICE")):
                    continue
                if path.suffix in {".py", ".go", ".json", ".h", ".cc", ".cpp"}:
                    continue
                stream.write(f"\n{'=' * 72}\n{source.name}/{path.relative_to(source)}\n\n")
                stream.write(path.read_text(encoding="utf-8", errors="replace"))


def toolchain(sources, work, prefix, host, target, jobs, options, suffix):
    """Build LLVM, glslang, and libdrm into prefix once per version of this file."""
    stamp = prefix / ".drawcall-recipe"
    recipe = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    if stamp.exists() and stamp.read_text() == recipe:
        return
    if prefix.exists():
        shutil.rmtree(prefix)
    cmake(sources["llvm"] / "llvm", work / "llvm-build", prefix, jobs, [
        f"-DLLVM_TARGETS_TO_BUILD={target}", "-DLLVM_BUILD_TOOLS=OFF", "-DLLVM_INCLUDE_TESTS=OFF",
        "-DLLVM_INCLUDE_EXAMPLES=OFF", "-DLLVM_INCLUDE_BENCHMARKS=OFF", "-DLLVM_INCLUDE_DOCS=OFF",
        "-DLLVM_ENABLE_ZLIB=OFF", "-DLLVM_ENABLE_ZSTD=OFF", "-DLLVM_ENABLE_LIBXML2=OFF",
        "-DLLVM_ENABLE_TERMINFO=OFF", "-DLLVM_ENABLE_LIBEDIT=OFF", "-DLLVM_ENABLE_RTTI=ON", *options,
    ], ["install-llvm-libraries", "install-llvm-headers", "install-cmake-exports", "llvm-config"])
    (prefix / "bin").mkdir(exist_ok=True)
    shutil.copy2(work / f"llvm-build/bin/llvm-config{suffix}", prefix / f"bin/llvm-config{suffix}")
    cmake(sources["glslang"], work / "glslang-build", prefix, jobs, [
        "-DENABLE_OPT=OFF", "-DGLSLANG_TESTS=OFF", "-DENABLE_HLSL=OFF", "-DBUILD_SHARED_LIBS=OFF", *options,
    ], ["install"])
    if host == "Linux":
        meson(sources["libdrm"], work / "libdrm-build", prefix, jobs, [
            "-Ddefault_library=static", "-Dtests=false", "-Dman-pages=disabled", "-Dudev=false",
            *[f"-D{driver}=disabled" for driver in
              ("intel", "radeon", "amdgpu", "nouveau", "vmwgfx", "freedreno", "vc4", "etnaviv")],
        ])
    stamp.write_text(recipe)


def build(work, output, jobs):
    host = platform.system()
    target = {"x86_64": "X86", "amd64": "X86", "aarch64": "AArch64", "arm64": "AArch64"}.get(platform.machine().lower())
    if host not in {"Linux", "Darwin", "Windows"} or target is None:
        raise RuntimeError(f"Unsupported Mesa build host: {host} {platform.machine()}")
    if jobs < 1:
        raise ValueError("Build jobs must be positive")
    work.mkdir(parents=True, exist_ok=True)
    output.mkdir(parents=True, exist_ok=True)
    prefix = work / "toolchain"
    suffix = ".exe" if host == "Windows" else ""
    options = []
    if host == "Darwin":
        os.environ["MACOSX_DEPLOYMENT_TARGET"] = "13.5"
        options = ["-DCMAKE_OSX_DEPLOYMENT_TARGET=13.5"]
    if host == "Windows":
        compiler = shutil.which("cl")
        if compiler is None:
            raise RuntimeError("Run the Mesa build in an MSVC developer environment")
        os.environ["PATH"] = str(Path(compiler).parent) + os.pathsep + os.environ["PATH"]
        os.environ.update(CC="cl", CXX="cl")
        options = ["-DCMAKE_C_COMPILER=cl", "-DCMAKE_CXX_COMPILER=cl", "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded"]
    sources = {name: fetch(name, work) for name in SOURCES
               if (name != "libdrm" or host == "Linux") and (name != "directx" or host == "Windows")}
    patch(sources, host)
    toolchain(sources, work, prefix, host, target, jobs, options, suffix)
    os.environ["PKG_CONFIG_PATH"] = str(prefix / "lib/pkgconfig")
    tools = work / "tools.ini"
    binaries = {"llvm-config": prefix / f"bin/llvm-config{suffix}", "glslangValidator": prefix / f"bin/glslang{suffix}"}
    if host == "Windows":
        chocolatey = Path(os.environ["ChocolateyInstall"]) / "lib/winflexbison3/tools"
        binaries.update(win_flex=chocolatey / "win_flex.exe", win_bison=chocolatey / "win_bison.exe")
    tools.write_text("[binaries]\n" + "".join(f"{name} = '{path.as_posix()}'\n" for name, path in binaries.items()))
    exports = f"-Wl,--version-script={sources['mesa']}/src/vulkan/vulkan.sym"
    platform_options = ["-Dplatforms=", "-Dshader-cache=enabled", "-Dstrip=true",
                        "-Dc_link_args=" + json.dumps([exports]),
                        "-Dcpp_link_args=" + json.dumps([exports, "-static-libstdc++", "-static-libgcc"])]
    if host == "Darwin":
        exports = json.dumps(["-Wl,-dead_strip", "-Wl,-exported_symbol,_vk_icd*"])
        platform_options = ["-Dplatforms=", "-Dshader-cache=enabled", "-Dstrip=true",
                            "-Dc_link_args=" + exports, "-Dcpp_link_args=" + exports]
    if host == "Windows":
        # Mesa25's Win32 WSI includes DirectX headers even for the CPU driver,
        # but its dependency detection only enables them for hardware drivers.
        os.environ["INCLUDE"] = str(sources["directx"] / "include") + os.pathsep + os.environ["INCLUDE"]
        platform_options = ["-Dplatforms=windows", "-Db_vscrt=mt", "-Dshader-cache=disabled",
                            "-Dmicrosoft-clc=disabled", "-Dgallium-d3d12-video=disabled"]
    meson(sources["mesa"], work / "mesa-build", work / "installed", jobs, [
        "--native-file", tools, "--force-fallback-for=zlib", "-Dzlib:default_library=static",
        "-Dgallium-drivers=llvmpipe", "-Dvulkan-drivers=swrast",
        "-Dglx=disabled", "-Degl=disabled", "-Dgles1=disabled", "-Dgles2=disabled", "-Dopengl=false",
        "-Dllvm=enabled", "-Dshared-llvm=disabled", "-Dgbm=disabled", "-Dvideo-codecs=", "-Dtools=",
        "-Dzstd=disabled", "-Dvulkan-layers=", "-Dxmlconfig=disabled", "-Dlibunwind=disabled",
        "-Dvalgrind=disabled", "-Dlmsensors=disabled", *platform_options,
    ])
    driver = {"Linux": "libvulkan_lvp.so", "Darwin": "libvulkan_lvp.dylib", "Windows": "vulkan_lvp.dll"}[host]
    libraries = list((work / "installed").rglob(driver))
    if len(libraries) != 1:
        raise RuntimeError(f"Expected one installed lavapipe library, got {libraries}")
    shutil.copy2(libraries[0], output / driver)
    manifest_path = output / "build.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["sources"]["deps/mesa.py"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    manifest["mesa"] = {name: {"url": SOURCES[name][0], "sha256": SOURCES[name][1]} for name in sources}
    manifest.setdefault("libraries", {})[driver] = hashlib.sha256((output / driver).read_bytes()).hexdigest()
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    notices(sources.values(), output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--work", type=Path, default=Path("build/mesa"))
    parser.add_argument("--jobs", type=int, default=4)
    args = parser.parse_args()
    build(args.work.resolve(), args.output.resolve(), args.jobs)
