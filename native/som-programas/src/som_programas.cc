// Som por programa no Windows (Captura Simples).
//
//  listar(excluirPids)      -> programas que têm som (sessões de áudio), com nome e nível atual
//  capturar(pid, callback)  -> capta o som desse processo e dos seus filhos (Application Loopback)
//                              callback(Float32Array estéreo 48 kHz, tempoEmMicrossegundos)
//                              ou callback(null, 0, mensagemDeErro)
//  parar(id)
//
// Os tempos vêm do relógio de alta precisão do Windows (QPC), o mesmo que o Chromium usa para
// os tempos das imagens: assim o som de cada programa fica alinhado com a imagem gravada.
// Requer Windows 10 versão 2004 ou mais recente.

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <tlhelp32.h>
#include <napi.h>

#include <algorithm>
#include <cmath>
#include <cwctype>
#include <atomic>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#if defined(__has_include)
#if __has_include(<audioclientactivationparams.h>)
#include <audioclientactivationparams.h>
#define TEM_ACTIVATION_PARAMS 1
#endif
#endif

#ifndef TEM_ACTIVATION_PARAMS
// Definições do SDK do Windows (audioclientactivationparams.h), para compiladores sem esse ficheiro
typedef enum AUDIOCLIENT_ACTIVATION_TYPE {
  AUDIOCLIENT_ACTIVATION_TYPE_DEFAULT = 0,
  AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1
} AUDIOCLIENT_ACTIVATION_TYPE;
typedef enum PROCESS_LOOPBACK_MODE {
  PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0,
  PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE = 1
} PROCESS_LOOPBACK_MODE;
typedef struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
  DWORD TargetProcessId;
  PROCESS_LOOPBACK_MODE ProcessLoopbackMode;
} AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS;
typedef struct AUDIOCLIENT_ACTIVATION_PARAMS {
  AUDIOCLIENT_ACTIVATION_TYPE ActivationType;
  union {
    AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams;
  };
} AUDIOCLIENT_ACTIVATION_PARAMS;
#define VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK L"VAD\\Process_Loopback"
#endif

namespace {

// GUIDs escritos à mão para não depender de __uuidof (iguais em MSVC e MinGW)
const CLSID kClsidMMDeviceEnumerator = {0xBCDE0395, 0xE52F, 0x467C, {0x8E, 0x3D, 0xC4, 0x57, 0x92, 0x91, 0x69, 0x2E}};
const IID kIidIMMDeviceEnumerator = {0xA95664D2, 0x9614, 0x4F35, {0xA7, 0x46, 0xDE, 0x8D, 0xB6, 0x36, 0x17, 0xE6}};
const IID kIidIAudioSessionManager2 = {0x77AA99A0, 0x1BD6, 0x484F, {0x8B, 0xC7, 0x2C, 0x65, 0x4C, 0x9A, 0x9B, 0x6F}};
const IID kIidIAudioSessionControl2 = {0xBFB7FF88, 0x7239, 0x4FC9, {0x8F, 0xA2, 0x07, 0xC9, 0x50, 0xBE, 0x9C, 0x6D}};
const IID kIidIAudioMeterInformation = {0xC02216F6, 0x8C67, 0x4B5B, {0x9D, 0x00, 0xD0, 0x08, 0xE7, 0x3E, 0x00, 0x64}};
const IID kIidIAudioClient = {0x1CB9AD4C, 0xDBFA, 0x4C32, {0xB1, 0x78, 0xC2, 0xF5, 0x68, 0xA7, 0x03, 0xB2}};
const IID kIidIAudioCaptureClient = {0xC8ADBD64, 0xE71E, 0x48A0, {0xA4, 0xDE, 0x18, 0x5C, 0x39, 0x5C, 0xD3, 0x17}};
const IID kIidIActivateHandler = {0x41D949AB, 0x9862, 0x444A, {0x80, 0xF6, 0xC2, 0x61, 0x33, 0x4D, 0xA5, 0xEB}};
const IID kIidIAgileObject = {0x94EA2B94, 0xE9CC, 0x49E0, {0xC0, 0xFF, 0xEE, 0x64, 0xCA, 0x8F, 0x5B, 0x90}};

// Medidor de nível de uma sessão (IAudioMeterInformation). Declarado aqui porque o MinGW só
// tem a declaração incompleta; a ordem dos métodos é a do SDK do Windows.
struct MedidorSom : public IUnknown {
  virtual HRESULT STDMETHODCALLTYPE GetPeakValue(float* pico) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetMeteringChannelCount(UINT* canais) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetChannelsPeakValues(UINT32 canais, float* picos) = 0;
  virtual HRESULT STDMETHODCALLTYPE QueryHardwareSupport(DWORD* suporte) = 0;
};

constexpr UINT32 kTaxa = 48000;
constexpr UINT32 kCanais = 2;
constexpr UINT32 kFramesPorEnvio = 480;  // 10 ms

template <typename T>
void Largar(T*& p) {
  if (p) {
    p->Release();
    p = nullptr;
  }
}

// COM na thread que chama: tenta MTA; se a thread já tiver outro modo (a do Electron é STA), usa esse
struct ComNaThread {
  bool desinicializar = false;
  ComNaThread() {
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    desinicializar = SUCCEEDED(hr);
  }
  ~ComNaThread() {
    if (desinicializar) CoUninitialize();
  }
};

std::string ParaUtf8(const std::wstring& w) {
  if (w.empty()) return std::string();
  int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
  std::string s(static_cast<size_t>(n), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()), &s[0], n, nullptr, nullptr);
  return s;
}

std::wstring CaminhoDoProcesso(DWORD pid) {
  std::wstring caminho;
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!h) return caminho;
  wchar_t buf[MAX_PATH * 2];
  DWORD tam = static_cast<DWORD>(sizeof(buf) / sizeof(buf[0]));
  if (QueryFullProcessImageNameW(h, 0, buf, &tam)) caminho.assign(buf, tam);
  CloseHandle(h);
  return caminho;
}

// Nome amigável: a "Descrição do ficheiro" do executável (ex.: "Discord"); senão o nome do .exe
std::wstring NomeAmigavel(const std::wstring& caminho) {
  std::wstring nomeExe = caminho.substr(caminho.find_last_of(L"\\/") + 1);
  size_t ponto = nomeExe.find_last_of(L'.');
  if (ponto != std::wstring::npos) nomeExe = nomeExe.substr(0, ponto);

  DWORD lixo = 0;
  DWORD tam = GetFileVersionInfoSizeW(caminho.c_str(), &lixo);
  if (tam == 0) return nomeExe;
  std::vector<BYTE> dados(tam);
  if (!GetFileVersionInfoW(caminho.c_str(), 0, tam, dados.data())) return nomeExe;

  struct Traducao { WORD lingua; WORD pagina; };
  Traducao* trad = nullptr;
  UINT tamTrad = 0;
  if (!VerQueryValueW(dados.data(), L"\\VarFileInfo\\Translation", reinterpret_cast<void**>(&trad), &tamTrad) || tamTrad < sizeof(Traducao)) {
    return nomeExe;
  }
  wchar_t chave[96];
  swprintf(chave, 96, L"\\StringFileInfo\\%04x%04x\\FileDescription", trad[0].lingua, trad[0].pagina);
  wchar_t* descricao = nullptr;
  UINT tamDesc = 0;
  if (VerQueryValueW(dados.data(), chave, reinterpret_cast<void**>(&descricao), &tamDesc) && tamDesc > 1 && descricao && descricao[0]) {
    std::wstring d(descricao);
    while (!d.empty() && (d.back() == L' ' || d.back() == L'\0')) d.pop_back();
    if (!d.empty()) return d;
  }
  return nomeExe;
}

struct Programa {
  std::wstring caminho;
  std::wstring nome;
  std::vector<DWORD> pids;
  bool ativo = false;
  float nivel = 0.0f;
};

std::mutex g_mutexNomes;
std::map<std::wstring, std::wstring> g_nomes;  // caminho -> nome amigável (ler a versão é lento)

std::wstring NomeEmCache(const std::wstring& caminho) {
  std::lock_guard<std::mutex> lock(g_mutexNomes);
  auto it = g_nomes.find(caminho);
  if (it != g_nomes.end()) return it->second;
  std::wstring nome = NomeAmigavel(caminho);
  g_nomes[caminho] = nome;
  return nome;
}

// Percorre as sessões de áudio de todas as saídas ativas (colunas, auscultadores, ...)
std::vector<Programa> ListarProgramas(const std::vector<DWORD>& excluir, std::string& erro) {
  std::vector<Programa> programas;
  std::map<std::wstring, size_t> porCaminho;
  ComNaThread com;

  IMMDeviceEnumerator* enumerador = nullptr;
  HRESULT hr = CoCreateInstance(kClsidMMDeviceEnumerator, nullptr, CLSCTX_ALL, kIidIMMDeviceEnumerator, reinterpret_cast<void**>(&enumerador));
  if (FAILED(hr)) {
    erro = "Não foi possível abrir os dispositivos de som.";
    return programas;
  }
  IMMDeviceCollection* saidas = nullptr;
  hr = enumerador->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &saidas);
  UINT nSaidas = 0;
  if (SUCCEEDED(hr)) saidas->GetCount(&nSaidas);

  for (UINT d = 0; d < nSaidas; d++) {
    IMMDevice* saida = nullptr;
    IAudioSessionManager2* gestor = nullptr;
    IAudioSessionEnumerator* sessoes = nullptr;
    if (FAILED(saidas->Item(d, &saida))) continue;
    if (SUCCEEDED(saida->Activate(kIidIAudioSessionManager2, CLSCTX_ALL, nullptr, reinterpret_cast<void**>(&gestor))) &&
        SUCCEEDED(gestor->GetSessionEnumerator(&sessoes))) {
      int n = 0;
      sessoes->GetCount(&n);
      for (int i = 0; i < n; i++) {
        IAudioSessionControl* ctl = nullptr;
        IAudioSessionControl2* ctl2 = nullptr;
        MedidorSom* medidor = nullptr;
        if (FAILED(sessoes->GetSession(i, &ctl))) continue;
        if (SUCCEEDED(ctl->QueryInterface(kIidIAudioSessionControl2, reinterpret_cast<void**>(&ctl2)))) {
          DWORD pid = 0;
          AudioSessionState estado = AudioSessionStateInactive;
          ctl2->GetProcessId(&pid);
          ctl->GetState(&estado);
          bool sistema = ctl2->IsSystemSoundsSession() == S_OK;
          bool excluido = std::find(excluir.begin(), excluir.end(), pid) != excluir.end();
          if (pid != 0 && !sistema && !excluido && estado != AudioSessionStateExpired) {
            std::wstring caminho = CaminhoDoProcesso(pid);
            if (!caminho.empty()) {
              float pico = 0.0f;
              if (SUCCEEDED(ctl->QueryInterface(kIidIAudioMeterInformation, reinterpret_cast<void**>(&medidor)))) {
                medidor->GetPeakValue(&pico);
              }
              std::wstring chave = caminho;
              std::transform(chave.begin(), chave.end(), chave.begin(), ::towlower);
              auto it = porCaminho.find(chave);
              if (it == porCaminho.end()) {
                Programa p;
                p.caminho = caminho;
                p.nome = NomeEmCache(caminho);
                porCaminho[chave] = programas.size();
                programas.push_back(p);
                it = porCaminho.find(chave);
              }
              Programa& p = programas[it->second];
              if (std::find(p.pids.begin(), p.pids.end(), pid) == p.pids.end()) p.pids.push_back(pid);
              p.ativo = p.ativo || estado == AudioSessionStateActive;
              p.nivel = std::max(p.nivel, pico);
            }
          }
        }
        Largar(medidor);
        Largar(ctl2);
        Largar(ctl);
      }
    }
    Largar(sessoes);
    Largar(gestor);
    Largar(saida);
  }
  Largar(saidas);
  Largar(enumerador);

  // Um processo filho de outro do mesmo programa já entra na captura do pai (a captura inclui
  // a árvore de processos): fica só o de cima, para o som não ser gravado duas vezes.
  std::map<DWORD, DWORD> pais;
  bool variosPids = false;
  for (const Programa& p : programas) variosPids = variosPids || p.pids.size() > 1;
  HANDLE foto = variosPids ? CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) : INVALID_HANDLE_VALUE;
  if (foto != INVALID_HANDLE_VALUE) {
    PROCESSENTRY32W pe;
    pe.dwSize = sizeof(pe);
    if (Process32FirstW(foto, &pe)) {
      do { pais[pe.th32ProcessID] = pe.th32ParentProcessID; } while (Process32NextW(foto, &pe));
    }
    CloseHandle(foto);
  }
  for (Programa& p : programas) {
    if (p.pids.size() < 2) continue;
    std::vector<DWORD> topo;
    for (DWORD pid : p.pids) {
      bool temAntepassado = false;
      DWORD atual = pid;
      for (int nivel = 0; nivel < 32; nivel++) {
        auto it = pais.find(atual);
        if (it == pais.end() || it->second == 0 || it->second == atual) break;
        atual = it->second;
        if (std::find(p.pids.begin(), p.pids.end(), atual) != p.pids.end()) { temAntepassado = true; break; }
      }
      if (!temAntepassado) topo.push_back(pid);
    }
    if (!topo.empty()) p.pids = topo;
  }
  return programas;
}

// ---------------------------------------------------------------------------------------------
// Captação por processo (Application Loopback)
// ---------------------------------------------------------------------------------------------
class Ativacao : public IActivateAudioInterfaceCompletionHandler {
 public:
  Ativacao() { evento_ = CreateEventW(nullptr, TRUE, FALSE, nullptr); }
  HANDLE Evento() const { return evento_; }
  HRESULT Resultado() const { return resultado_; }
  IAudioClient* LevarCliente() {
    IAudioClient* c = cliente_;
    cliente_ = nullptr;
    return c;
  }

  STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (IsEqualIID(riid, IID_IUnknown) || IsEqualIID(riid, kIidIActivateHandler) || IsEqualIID(riid, kIidIAgileObject)) {
      *ppv = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return static_cast<ULONG>(InterlockedIncrement(&ref_)); }
  STDMETHODIMP_(ULONG) Release() override {
    LONG r = InterlockedDecrement(&ref_);
    if (r == 0) delete this;
    return static_cast<ULONG>(r);
  }
  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operacao) override {
    HRESULT hrAtivacao = E_FAIL;
    IUnknown* ativada = nullptr;
    HRESULT hr = operacao->GetActivateResult(&hrAtivacao, &ativada);
    if (SUCCEEDED(hr) && SUCCEEDED(hrAtivacao) && ativada) {
      resultado_ = ativada->QueryInterface(kIidIAudioClient, reinterpret_cast<void**>(&cliente_));
    } else {
      resultado_ = FAILED(hr) ? hr : hrAtivacao;
    }
    if (ativada) ativada->Release();
    SetEvent(evento_);
    return S_OK;
  }

 private:
  virtual ~Ativacao() {
    if (cliente_) cliente_->Release();
    CloseHandle(evento_);
  }
  LONG ref_ = 1;
  HANDLE evento_ = nullptr;
  HRESULT resultado_ = E_FAIL;
  IAudioClient* cliente_ = nullptr;
};

struct Pacote {
  std::vector<float> amostras;  // estéreo intercalado
  double tempoUs = 0;
  std::string erro;
};

struct Captura {
  std::atomic<bool> parar{false};
  std::thread linha;
  Napi::ThreadSafeFunction tsfn;
};

void EntregarAoJs(Napi::Env env, Napi::Function callback, Pacote* pacote) {
  if (env != nullptr && callback != nullptr) {
    if (!pacote->erro.empty()) {
      callback.Call({env.Null(), Napi::Number::New(env, 0), Napi::String::New(env, pacote->erro)});
    } else {
      auto f32 = Napi::Float32Array::New(env, pacote->amostras.size());
      std::copy(pacote->amostras.begin(), pacote->amostras.end(), f32.Data());
      callback.Call({f32, Napi::Number::New(env, pacote->tempoUs)});
    }
  }
  delete pacote;
}

void Enviar(Captura* c, Pacote* p) {
  if (c->tsfn.NonBlockingCall(p, EntregarAoJs) != napi_ok) delete p;
}

void EnviarErro(Captura* c, const std::string& mensagem) {
  Pacote* p = new Pacote();
  p->erro = mensagem;
  Enviar(c, p);
}

void LinhaDeCaptura(Captura* c, DWORD pid) {
  ComNaThread com;

  AUDIOCLIENT_ACTIVATION_PARAMS params = {};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = pid;
  params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
  PROPVARIANT pv;
  PropVariantInit(&pv);
  pv.vt = VT_BLOB;
  pv.blob.cbSize = sizeof(params);
  pv.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

  Ativacao* ativacao = new Ativacao();
  IActivateAudioInterfaceAsyncOperation* operacao = nullptr;
  HRESULT hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, kIidIAudioClient, &pv, ativacao, &operacao);
  if (FAILED(hr)) {
    ativacao->Release();
    EnviarErro(c, "Este Windows não deixa captar o som de um programa (precisa do Windows 10 2004 ou mais recente).");
    return;
  }
  WaitForSingleObject(ativacao->Evento(), 5000);
  IAudioClient* cliente = ativacao->LevarCliente();
  HRESULT hrAtivacao = ativacao->Resultado();
  Largar(operacao);
  ativacao->Release();
  if (FAILED(hrAtivacao) || !cliente) {
    Largar(cliente);
    EnviarErro(c, "Não foi possível captar o som deste programa.");
    return;
  }

  WAVEFORMATEX formato = {};
  formato.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
  formato.nChannels = kCanais;
  formato.nSamplesPerSec = kTaxa;
  formato.wBitsPerSample = 32;
  formato.nBlockAlign = static_cast<WORD>(kCanais * 4);
  formato.nAvgBytesPerSec = kTaxa * formato.nBlockAlign;

  const DWORD bandeiras = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                          AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
  hr = cliente->Initialize(AUDCLNT_SHAREMODE_SHARED, bandeiras, 200000 /* 20 ms */, 0, &formato, nullptr);
  HANDLE evento = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  IAudioCaptureClient* captador = nullptr;
  if (SUCCEEDED(hr)) hr = cliente->SetEventHandle(evento);
  if (SUCCEEDED(hr)) hr = cliente->GetService(kIidIAudioCaptureClient, reinterpret_cast<void**>(&captador));
  if (SUCCEEDED(hr)) hr = cliente->Start();
  if (FAILED(hr)) {
    Largar(captador);
    Largar(cliente);
    CloseHandle(evento);
    EnviarErro(c, "Não foi possível começar a captar o som deste programa.");
    return;
  }

  std::vector<float> lote;
  lote.reserve(kFramesPorEnvio * kCanais * 4);
  double inicioLoteUs = 0;
  double esperadoUs = -1;

  auto despachar = [&]() {
    if (lote.empty()) return;
    Pacote* p = new Pacote();
    p->amostras.swap(lote);
    p->tempoUs = inicioLoteUs;
    Enviar(c, p);
    lote.clear();
    lote.reserve(kFramesPorEnvio * kCanais * 4);
  };

  while (!c->parar.load()) {
    WaitForSingleObject(evento, 100);
    UINT32 proximo = 0;
    while (!c->parar.load() && SUCCEEDED(captador->GetNextPacketSize(&proximo)) && proximo > 0) {
      BYTE* dados = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      UINT64 posicao = 0;
      UINT64 qpc100ns = 0;
      if (FAILED(captador->GetBuffer(&dados, &frames, &flags, &posicao, &qpc100ns))) break;
      double tempoUs = static_cast<double>(qpc100ns) / 10.0;
      if (qpc100ns == 0 || (flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR)) {
        // Sem tempo do Windows: usa o relógio agora, menos a duração deste pacote
        LARGE_INTEGER contador, frequencia;
        QueryPerformanceCounter(&contador);
        QueryPerformanceFrequency(&frequencia);
        tempoUs = static_cast<double>(contador.QuadPart) * 1e6 / static_cast<double>(frequencia.QuadPart) -
                  static_cast<double>(frames) * 1e6 / kTaxa;
      }

      // Falha no fluxo (ou primeiro pacote): começa um lote novo com o seu próprio tempo
      if (lote.empty()) {
        inicioLoteUs = tempoUs;
      } else if (esperadoUs >= 0 && std::abs(tempoUs - esperadoUs) > 2000.0) {
        despachar();
        inicioLoteUs = tempoUs;
      }
      size_t n = static_cast<size_t>(frames) * kCanais;
      if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) || !dados) {
        lote.insert(lote.end(), n, 0.0f);
      } else {
        const float* f = reinterpret_cast<const float*>(dados);
        lote.insert(lote.end(), f, f + n);
      }
      esperadoUs = tempoUs + static_cast<double>(frames) * 1e6 / kTaxa;
      captador->ReleaseBuffer(frames);

      if (lote.size() >= static_cast<size_t>(kFramesPorEnvio) * kCanais) despachar();
    }
  }
  despachar();
  cliente->Stop();
  Largar(captador);
  Largar(cliente);
  CloseHandle(evento);
}

std::mutex g_mutexCapturas;
std::map<int, std::unique_ptr<Captura>> g_capturas;
int g_proximoId = 1;

void PararCaptura(int id) {
  std::unique_ptr<Captura> c;
  {
    std::lock_guard<std::mutex> lock(g_mutexCapturas);
    auto it = g_capturas.find(id);
    if (it == g_capturas.end()) return;
    c = std::move(it->second);
    g_capturas.erase(it);
  }
  c->parar.store(true);
  if (c->linha.joinable()) c->linha.join();
  c->tsfn.Release();
}

// ---------------------------------------------------------------------------------------------
// Funções expostas ao JavaScript
// ---------------------------------------------------------------------------------------------
Napi::Value Listar(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::vector<DWORD> excluir;
  if (info.Length() > 0 && info[0].IsArray()) {
    Napi::Array a = info[0].As<Napi::Array>();
    for (uint32_t i = 0; i < a.Length(); i++) {
      Napi::Value v = a.Get(i);
      if (v.IsNumber()) excluir.push_back(static_cast<DWORD>(v.As<Napi::Number>().Uint32Value()));
    }
  }
  std::string erro;
  std::vector<Programa> programas = ListarProgramas(excluir, erro);
  if (!erro.empty()) {
    Napi::Error::New(env, erro).ThrowAsJavaScriptException();
    return env.Null();
  }
  Napi::Array resultado = Napi::Array::New(env, programas.size());
  for (size_t i = 0; i < programas.size(); i++) {
    const Programa& p = programas[i];
    Napi::Object o = Napi::Object::New(env);
    std::wstring chave = p.caminho;
    std::transform(chave.begin(), chave.end(), chave.begin(), ::towlower);
    o.Set("id", ParaUtf8(chave));
    o.Set("nome", ParaUtf8(p.nome));
    o.Set("caminho", ParaUtf8(p.caminho));
    o.Set("ativo", Napi::Boolean::New(env, p.ativo));
    o.Set("nivel", Napi::Number::New(env, p.nivel));
    Napi::Array pids = Napi::Array::New(env, p.pids.size());
    for (size_t j = 0; j < p.pids.size(); j++) pids.Set(static_cast<uint32_t>(j), Napi::Number::New(env, p.pids[j]));
    o.Set("pids", pids);
    resultado.Set(static_cast<uint32_t>(i), o);
  }
  return resultado;
}

Napi::Value Capturar(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsFunction()) {
    Napi::TypeError::New(env, "capturar(pid, callback)").ThrowAsJavaScriptException();
    return env.Null();
  }
  DWORD pid = info[0].As<Napi::Number>().Uint32Value();
  auto c = std::make_unique<Captura>();
  c->tsfn = Napi::ThreadSafeFunction::New(env, info[1].As<Napi::Function>(), "som_programas", 0, 1);
  Captura* ptr = c.get();
  int id;
  {
    std::lock_guard<std::mutex> lock(g_mutexCapturas);
    id = g_proximoId++;
    g_capturas[id] = std::move(c);
  }
  ptr->linha = std::thread(LinhaDeCaptura, ptr, pid);
  return Napi::Number::New(env, id);
}

Napi::Value Parar(const Napi::CallbackInfo& info) {
  if (info.Length() > 0 && info[0].IsNumber()) PararCaptura(info[0].As<Napi::Number>().Int32Value());
  return info.Env().Undefined();
}

void PararTudo(void*) {
  std::vector<int> ids;
  {
    std::lock_guard<std::mutex> lock(g_mutexCapturas);
    for (auto& par : g_capturas) ids.push_back(par.first);
  }
  for (int id : ids) PararCaptura(id);
}

Napi::Object Iniciar(Napi::Env env, Napi::Object exports) {
  exports.Set("listar", Napi::Function::New(env, Listar));
  exports.Set("capturar", Napi::Function::New(env, Capturar));
  exports.Set("parar", Napi::Function::New(env, Parar));
  exports.Set("taxa", Napi::Number::New(env, kTaxa));
  exports.Set("canais", Napi::Number::New(env, kCanais));
  napi_add_env_cleanup_hook(env, PararTudo, nullptr);
  return exports;
}

}  // namespace

NODE_API_MODULE(som_programas, Iniciar)
