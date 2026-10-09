#include <Windows.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <mmdeviceapi.h>
#include <propvarutil.h>
#include <wrl/client.h>
#include <wrl/implements.h>

#include <atomic>
#include <cstdint>
#include <cstring>
#include <thread>
#include <vector>

#pragma comment(lib, "Mmdevapi.lib")
#pragma comment(lib, "Ole32.lib")
#pragma comment(lib, "WindowsApp.lib")

using Microsoft::WRL::ClassicCom;
using Microsoft::WRL::ComPtr;
using Microsoft::WRL::FtmBase;
using Microsoft::WRL::Make;
using Microsoft::WRL::RuntimeClass;
using Microsoft::WRL::RuntimeClassFlags;

using AudioCallback = void (*)(const float *, uint32_t, uint64_t, void *);

class ProcessLoopbackCapture final
    : public RuntimeClass<RuntimeClassFlags<ClassicCom>, FtmBase,
                          IActivateAudioInterfaceCompletionHandler> {
  public:
    HRESULT RuntimeClassInitialize() { return S_OK; }

    HRESULT Start(DWORD process_id, AudioCallback callback, void *context) {
        callback_ = callback;
        context_ = context;
        ready_event_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        activation_event_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        sample_event_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
        stop_event_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        if (!ready_event_ || !activation_event_ || !sample_event_ || !stop_event_) {
            return HRESULT_FROM_WIN32(GetLastError());
        }

        ComPtr<ProcessLoopbackCapture> self(this);
        thread_ = std::thread([self, process_id]() { self->Run(process_id); });
        DWORD wait = WaitForSingleObject(ready_event_, 10000);
        if (wait != WAIT_OBJECT_0) {
            return wait == WAIT_TIMEOUT ? HRESULT_FROM_WIN32(ERROR_TIMEOUT)
                                        : HRESULT_FROM_WIN32(GetLastError());
        }
        return initialization_result_;
    }

    void Stop() {
        if (stop_event_) {
            SetEvent(stop_event_);
        }
        if (thread_.joinable()) {
            thread_.join();
        }
    }

    HRESULT Play() { return audio_client_ ? audio_client_->Start() : E_UNEXPECTED; }

    HRESULT Pause() { return audio_client_ ? audio_client_->Stop() : E_UNEXPECTED; }

    HRESULT STDMETHODCALLTYPE
    ActivateCompleted(IActivateAudioInterfaceAsyncOperation *operation) override {
        HRESULT activation_result = E_FAIL;
        ComPtr<IUnknown> audio_interface;
        HRESULT result = operation->GetActivateResult(&activation_result, &audio_interface);
        if (SUCCEEDED(result)) {
            result = activation_result;
        }
        if (SUCCEEDED(result)) {
            result = audio_interface.As(&audio_client_);
        }
        activation_result_ = result;
        SetEvent(activation_event_);
        return S_OK;
    }

  private:
    ~ProcessLoopbackCapture() override {
        Stop();
        for (HANDLE handle : {ready_event_, activation_event_, sample_event_, stop_event_}) {
            if (handle) {
                CloseHandle(handle);
            }
        }
    }

    void Run(DWORD process_id) {
        HRESULT result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        bool uninitialize = SUCCEEDED(result);
        if (result == RPC_E_CHANGED_MODE) {
            result = S_OK;
        }
        if (SUCCEEDED(result)) {
            result = Activate(process_id);
        }
        if (SUCCEEDED(result)) {
            result = InitializeClient();
        }
        initialization_result_ = result;
        SetEvent(ready_event_);

        if (SUCCEEDED(result)) {
            Capture();
        }
        if (audio_client_) {
            audio_client_->Stop();
        }
        capture_client_.Reset();
        audio_client_.Reset();
        if (uninitialize) {
            CoUninitialize();
        }
    }

    HRESULT Activate(DWORD process_id) {
        AUDIOCLIENT_ACTIVATION_PARAMS params{};
        params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
        params.ProcessLoopbackParams.TargetProcessId = process_id;
        params.ProcessLoopbackParams.ProcessLoopbackMode =
            PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

        PROPVARIANT variant{};
        variant.vt = VT_BLOB;
        variant.blob.cbSize = sizeof(params);
        variant.blob.pBlobData = reinterpret_cast<BYTE *>(&params);

        ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
        HRESULT result = ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &variant,
            this, &operation);
        if (FAILED(result)) {
            return result;
        }
        DWORD wait = WaitForSingleObject(activation_event_, 10000);
        if (wait != WAIT_OBJECT_0) {
            return wait == WAIT_TIMEOUT ? HRESULT_FROM_WIN32(ERROR_TIMEOUT)
                                        : HRESULT_FROM_WIN32(GetLastError());
        }
        return activation_result_;
    }

    HRESULT InitializeClient() {
        WAVEFORMATEX format{};
        format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
        format.nChannels = 2;
        format.nSamplesPerSec = 48000;
        format.wBitsPerSample = 32;
        format.nBlockAlign = format.nChannels * format.wBitsPerSample / 8;
        format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;

        HRESULT result = audio_client_->Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
                AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
            0, 0, &format, nullptr);
        if (FAILED(result)) {
            return result;
        }
        result = audio_client_->SetEventHandle(sample_event_);
        if (FAILED(result)) {
            return result;
        }
        result = audio_client_->GetService(IID_PPV_ARGS(&capture_client_));
        if (FAILED(result)) {
            return result;
        }
        return S_OK;
    }

    void Capture() {
        HANDLE events[] = {stop_event_, sample_event_};
        while (WaitForMultipleObjects(2, events, FALSE, INFINITE) == WAIT_OBJECT_0 + 1) {
            UINT32 frames = 0;
            while (SUCCEEDED(capture_client_->GetNextPacketSize(&frames)) && frames > 0) {
                BYTE *data = nullptr;
                DWORD flags = 0;
                UINT64 device_position = 0;
                UINT64 performance_position = 0;
                if (FAILED(capture_client_->GetBuffer(&data, &frames, &flags,
                                                      &device_position,
                                                      &performance_position))) {
                    break;
                }
                if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0) {
                    silence_.assign(static_cast<size_t>(frames) * 2, 0.0f);
                    callback_(silence_.data(), frames, performance_position, context_);
                } else {
                    callback_(reinterpret_cast<const float *>(data), frames,
                              performance_position, context_);
                }
                capture_client_->ReleaseBuffer(frames);
            }
        }
    }

    AudioCallback callback_ = nullptr;
    void *context_ = nullptr;
    HANDLE ready_event_ = nullptr;
    HANDLE activation_event_ = nullptr;
    HANDLE sample_event_ = nullptr;
    HANDLE stop_event_ = nullptr;
    HRESULT initialization_result_ = E_PENDING;
    HRESULT activation_result_ = E_PENDING;
    ComPtr<IAudioClient> audio_client_;
    ComPtr<IAudioCaptureClient> capture_client_;
    std::thread thread_;
    std::vector<float> silence_;
};

extern "C" void *cap_process_audio_start(uint32_t process_id,
                                          AudioCallback callback, void *context,
                                          int32_t *error) {
    auto capture = Make<ProcessLoopbackCapture>();
    if (!capture) {
        *error = E_OUTOFMEMORY;
        return nullptr;
    }
    HRESULT result = capture->Start(process_id, callback, context);
    if (FAILED(result)) {
        capture->Stop();
        *error = result;
        return nullptr;
    }
    *error = S_OK;
    return capture.Detach();
}

extern "C" void cap_process_audio_stop(void *handle) {
    if (!handle) {
        return;
    }
    auto *capture = static_cast<ProcessLoopbackCapture *>(handle);
    capture->Stop();
    capture->Release();
}

extern "C" int32_t cap_process_audio_play(void *handle) {
    return handle ? static_cast<ProcessLoopbackCapture *>(handle)->Play() : E_POINTER;
}

extern "C" int32_t cap_process_audio_pause(void *handle) {
    return handle ? static_cast<ProcessLoopbackCapture *>(handle)->Pause() : E_POINTER;
}
