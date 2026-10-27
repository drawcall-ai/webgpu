from pathlib import Path


def patch(root, musl=False):
    """Enable the native image and driver boundaries without changing GPU validation."""
    here = Path(__file__).parent
    base = root / "src/dawn"
    names = ["node/interop/Browser.idl", "node/Module.cpp", "node/binding/GPUQueue.h",
             "node/binding/GPUQueue.cpp", "node/binding/GPUDevice.cpp", "native/vulkan/BackendVk.cpp",
             "common/DynamicLib.cpp", "common/SystemUtils.cpp", "native/vulkan/BackendVk.h",
             "native/vulkan/VulkanInfo.h", "native/vulkan/VulkanInfo.cpp",
             "platform/WorkerThread.h", "platform/WorkerThread.cpp"]
    paths = {name: base / name for name in names}
    paths["tools/fetch_dawn_dependencies.py"] = root / "tools/fetch_dawn_dependencies.py"
    sources = {}
    for name, path in paths.items():
        original = path.with_suffix(path.suffix + ".platform-original")
        if not original.exists():
            original.write_bytes(path.read_bytes())
        sources[name] = original.read_text()

    def change(name, old, new):
        source = sources[name]
        if source.count(old) != 1:
            raise RuntimeError(f"Dawn patch anchor must occur exactly once in {name}: {old}")
        sources[name] = source.replace(old, new)

    if musl:
        # musl defaults to 128 KiB per pthread, which overflows during asynchronous
        # shader compilation. Size only Dawn's compiler workers, not all process threads.
        change("platform/WorkerThread.h", "#include <thread>", "#include <pthread.h>")
        change("platform/WorkerThread.h", "    std::thread mThread;",
               "    PostWorkerJobCallback mCallback;\n    void* mUserdata;\n    pthread_t mThread;")
        change("platform/WorkerThread.cpp",
               "    : mThread(&AsyncJobHandleImpl::JobThreadLoop, this, cb, userdata) {}",
               """    : mCallback(cb), mUserdata(userdata) {
    pthread_attr_t attributes;
    DAWN_CHECK(pthread_attr_init(&attributes) == 0);
    DAWN_CHECK(pthread_attr_setstacksize(&attributes, 8 * 1024 * 1024) == 0);
    const int result = pthread_create(&mThread, &attributes, [](void* data) -> void* {
        auto* job = static_cast<AsyncJobHandleImpl*>(data);
        job->JobThreadLoop(job->mCallback, job->mUserdata);
        return nullptr;
    }, this);
    DAWN_CHECK(pthread_attr_destroy(&attributes) == 0);
    DAWN_CHECK(result == 0);
}""")
        change("platform/WorkerThread.cpp", "        mThread.join();",
               "        DAWN_CHECK(pthread_join(mThread, nullptr) == 0);")

    # The pinned fetcher hides Git failures and retries a remote that shallow clones never create.
    change("tools/fetch_dawn_dependencies.py",
           """        git = lambda *x: subprocess.run([args.git, '-C', submodule_path, *x],
                                        capture_output=True)""",
           """        def git(*arguments):
            command = [args.git, '-C', submodule_path, *arguments]
            result = subprocess.run(command, capture_output=True)
            if result.returncode and arguments[0] not in ('rev-parse', 'cat-file'):
                raise RuntimeError(f"Git command failed: {command}\\n"
                                   + result.stderr.decode(errors='replace'))
            return result""")
    change("tools/fetch_dawn_dependencies.py", "git('fetch', 'origin', git_tag, '--depth', '1')",
           "git('fetch', git_url, git_tag, '--depth', '1')")
    change("tools/fetch_dawn_dependencies.py", "git('fetch', 'origin')", "git('fetch', git_url)")
    change("node/interop/Browser.idl", "[LegacyNoInterfaceObject] interface ImageBitmap {};",
           "interface ImageBitmap { readonly attribute unsigned long width; "
           "readonly attribute unsigned long height; undefined close(); };")
    sources["node/binding/ImageBitmap.h"] = (here / "bitmap.h").read_text()
    change("node/Module.cpp", "#include <filesystem>",
           '#include <filesystem>\n#include <cmath>\n#include "src/dawn/node/binding/ImageBitmap.h"')
    change("node/Module.cpp", "    return exports;", (here / "factory.cpp").read_text() + "\n    return exports;")
    change("node/binding/GPUQueue.h", "GPUQueue(wgpu::Queue queue,", "GPUQueue(wgpu::Device device, wgpu::Queue queue,")
    change("node/binding/GPUQueue.h", "    wgpu::Queue queue_;", "    wgpu::Device device_;\n    wgpu::Queue queue_;")
    change("node/binding/GPUQueue.cpp", '#include "src/dawn/node/binding/GPUBuffer.h"',
           '#include "src/dawn/node/binding/GPUBuffer.h"\n'
           '#include "src/dawn/node/binding/ImageBitmap.h"\n'
           '#include "src/dawn/node/binding/Errors.h"')
    change("node/binding/GPUQueue.cpp", "GPUQueue::GPUQueue(wgpu::Queue queue,",
           "GPUQueue::GPUQueue(wgpu::Device device, wgpu::Queue queue,")
    change("node/binding/GPUQueue.cpp", ": queue_(std::move(queue))",
           ": device_(std::move(device)), queue_(std::move(queue))")
    change("node/binding/GPUQueue.cpp", "    UNIMPLEMENTED(env);", (here / "queue.cpp").read_text())
    change("node/binding/GPUDevice.cpp", "env, device_.GetQueue(), async_", "env, device_, device_.GetQueue(), async_")
    # Our bundled Vulkan loader and Mesa driver are available on macOS too.
    change("native/vulkan/BackendVk.cpp", """#if DAWN_PLATFORM_IS(MACOS)
        // On Mac, we don't expect non-Swiftshader Vulkan to be available.
        if (icd == ICD::None) {
            continue;
        }
#endif  // DAWN_PLATFORM_IS(MACOS)
""", "")
    change("native/vulkan/BackendVk.h", "    DynamicLib mVulkanLib;",
           "    DynamicLib mDriverLib;\n"
           "    PFN_vkGetInstanceProcAddrLUNARG mDriverGetInstanceProcAddr = nullptr;\n"
           "    DynamicLib mVulkanLib;")
    change("native/vulkan/BackendVk.cpp",
           "    DAWN_TRY_ASSIGN(mGlobalInfo, GatherGlobalInfo(mFunctions));",
           (here / "driver.cpp").read_text().rstrip())
    change("native/vulkan/BackendVk.cpp", "    std::vector<const char*> extensionNames;",
           "    std::vector<const char*> extensionNames = {VK_LUNARG_DIRECT_DRIVER_LOADING_EXTENSION_NAME};")
    change("native/vulkan/BackendVk.cpp", "    PNextChainBuilder createInfoChain(&createInfo);", """    PNextChainBuilder createInfoChain(&createInfo);
    VkDirectDriverLoadingInfoLUNARG driverInfo = {};
    driverInfo.sType = VK_STRUCTURE_TYPE_DIRECT_DRIVER_LOADING_INFO_LUNARG;
    driverInfo.pfnGetInstanceProcAddr = mDriverGetInstanceProcAddr;
    VkDirectDriverLoadingListLUNARG driverList = {};
    driverList.mode = VK_DIRECT_DRIVER_LOADING_MODE_EXCLUSIVE_LUNARG;
    driverList.driverCount = 1;
    driverList.pDrivers = &driverInfo;
    createInfoChain.Add(&driverList, VK_STRUCTURE_TYPE_DIRECT_DRIVER_LOADING_LIST_LUNARG);""")
    change("native/vulkan/VulkanInfo.h",
           "ResultOrError<VulkanGlobalInfo> GatherGlobalInfo(const VulkanFunctions& vkFunctions);",
           "ResultOrError<VulkanGlobalInfo> GatherGlobalInfo(const VulkanFunctions& vkFunctions,\n"
           "                                               const VulkanFunctions* driverFunctions = nullptr);")
    change("native/vulkan/VulkanInfo.cpp",
           "#include <cstring>", "#include <algorithm>\n#include <cstring>")
    change("native/vulkan/VulkanInfo.cpp",
           "ResultOrError<VulkanGlobalInfo> GatherGlobalInfo(const VulkanFunctions& vkFunctions) {",
           "ResultOrError<VulkanGlobalInfo> GatherGlobalInfo(const VulkanFunctions& vkFunctions,\n"
           "                                               const VulkanFunctions* driverFunctions) {")
    change("native/vulkan/VulkanInfo.cpp", "    DAWN_INVALID_IF(info.apiVersion < kRequiredVulkanVersion,", """    if (driverFunctions != nullptr) {
        uint32_t driverVersion = VK_API_VERSION_1_0;
        DAWN_TRY(CheckVkSuccess(driverFunctions->EnumerateInstanceVersion(&driverVersion),
                                "vkEnumerateInstanceVersion (bundled driver)"));
        info.apiVersion = std::min(info.apiVersion, driverVersion);
    }

    DAWN_INVALID_IF(info.apiVersion < kRequiredVulkanVersion,""")
    change("native/vulkan/VulkanInfo.cpp",
           "        DAWN_TRY_ASSIGN(info.extensions, GatherInstanceExtensions(nullptr, vkFunctions, knownExts));",
           """        DAWN_TRY_ASSIGN(info.extensions, GatherInstanceExtensions(nullptr, vkFunctions, knownExts));
        if (driverFunctions != nullptr) {
            bool loaderDebugUtils = info.extensions[InstanceExt::DebugUtils];
            DAWN_TRY_ASSIGN(info.extensions,
                            GatherInstanceExtensions(nullptr, *driverFunctions, knownExts));
            // Other loader-advertised surface capabilities can belong to unrelated system ICDs.
            info.extensions.set(InstanceExt::DebugUtils,
                                loaderDebugUtils || info.extensions[InstanceExt::DebugUtils]);
        }""")
    change("common/DynamicLib.cpp", """#if DAWN_PLATFORM_IS(WINUWP)
#include "src/dawn/common/WindowsUtils.h"
#endif""", '#include "src/dawn/common/WindowsUtils.h"')
    change("common/DynamicLib.cpp", "LoadLibraryExA(filename.c_str(), nullptr, loadLibraryFlags)",
           "LoadLibraryExW(UTF8ToWStr(filename.c_str()).c_str(), nullptr, loadLibraryFlags)")
    change("common/SystemUtils.cpp", '#include "src/utils/windows_with_undefs.h"',
           '#include "src/utils/windows_with_undefs.h"\n#include "src/dawn/common/WindowsUtils.h"\n#include <algorithm>')
    change("common/SystemUtils.cpp", """    std::array<char, MAX_PATH> executableFileBuf;
    DWORD executablePathLen = GetModuleFileNameA(module, executableFileBuf.data(),
                                                 static_cast<DWORD>(executableFileBuf.size()));
    if (executablePathLen == 0) {
        return {};
    }
    return executableFileBuf.data();""", """    constexpr size_t maxPathLength = 32768;
    std::vector<wchar_t> path(MAX_PATH);
    for (;;) {
        DWORD length = GetModuleFileNameW(module, path.data(), static_cast<DWORD>(path.size()));
        if (length == 0) {
            return {};
        }
        if (length < path.size()) {
            return WCharToUTF8(path.data());
        }
        if (path.size() == maxPathLength) {
            return {};
        }
        path.resize(std::min(path.size() * 2, maxPathLength));
    }""")
    for name, contents in sources.items():
        path = paths.get(name, base / name)
        if not path.exists() or path.read_text() != contents:
            path.write_text(contents)
