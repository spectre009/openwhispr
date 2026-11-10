/**
 * Windows Process Stats
 *
 * OpenWhispr's process inventory on Windows (src/helpers/processInventory.js):
 * every process in the tree under --root, walked recursively (this helper and
 * its own children excluded), with what Electron's app.getAppMetrics() can't
 * see: helper programs, handles, threads, GDI and USER objects, and with --gpu
 * the graphics memory each one holds (PDH, English counter names, so any
 * Windows language works) and how many processes on this PC hold dedicated
 * graphics memory. In --stream mode it also reports each process's busiest 3D
 * engine, from one PDH query kept open so every sample compares a real interval.
 *
 * Usage:
 *   windows-process-stats --once --root <pid> [--gpu]
 *   windows-process-stats --stream --root <pid> [--interval <ms>] [--gpu]
 *
 * --once prints one JSON object and exits. --stream prints one JSON line per
 * interval (at least 1000 ms, default 2000) until stdin closes or the root
 * process exits; it keeps the tree's process handles between samples (an open
 * handle keeps a PID from being reused), drops a process as soon as it exits,
 * and walks the process list again every 5th sample for new children and
 * thread counts. Exe file names only, never paths or command lines. A value
 * it can't read is null, with an error code in the process's "errors"; nothing
 * is ever reported as 0 because it failed.
 *
 * Exit codes: 0 ok, 2 bad arguments, 3 root not found, 4 process listing failed.
 *
 * Compile:
 *   cl /O2 windows-process-stats.c /Fe:windows-process-stats.exe pdh.lib psapi.lib user32.lib
 *   or: gcc -O2 windows-process-stats.c -o windows-process-stats.exe -lpdh -lpsapi -luser32
 */

#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#ifndef PSAPI_VERSION
#define PSAPI_VERSION 2
#endif
// swscanf works on MinGW too, unlike swscanf_s.
#define _CRT_SECURE_NO_WARNINGS

#include <windows.h>
#include <psapi.h>
#include <pdh.h>
#include <pdhmsg.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include <io.h>
#include <fcntl.h>

#define MAX_PROCS 256
#define MAX_ERRORS 8
#define MAX_ENGINES 64
#define MIN_INTERVAL_MS 1000
// A stream walks the whole process list (most of a sample's cost) every this
// many samples, for new children and thread counts; in between it reads the
// processes it holds.
#define LIST_EVERY 5
#define DEFAULT_INTERVAL_MS 2000
// 100 ns ticks between 1601-01-01 (FILETIME) and 1970-01-01 (Unix).
#define EPOCH_DIFF_100NS 116444736000000000ULL

typedef struct {
  DWORD luidHigh;
  DWORD luidLow;
  DWORD phys;
  DWORD eng;
  double sum;
} EngineSlot;

typedef struct {
  DWORD pid;
  DWORD ppid;
  DWORD threads;
  WCHAR exe[MAX_PATH];
  HANDLE handle;
  int haveCreated;
  ULONGLONG created;
  // Per sample from here (resetSample).
  int exited;
  int haveTimes;
  ULONGLONG cpu100ns;
  int haveMem;
  ULONGLONG ws, priv, peak;
  int haveHandles;
  DWORD handles;
  int haveGdi;
  DWORD gdi;
  int haveUser;
  DWORD user;
  ULONGLONG gpuDedicated, gpuShared;
  int engineCount;
  EngineSlot engines[MAX_ENGINES];
  const char* errors[MAX_ERRORS];
  int errorCount;
} Proc;

// The leading fields of SYSTEM_PROCESS_INFORMATION (winternl.h names most of
// them Reserved; the layout has been stable since Windows NT). One
// NtQuerySystemInformation call lists every process with its parent, start
// time, thread count and image name: measured 10.5 ms for 813 processes, where
// a Toolhelp snapshot and its walk took 18 ms.
typedef struct {
  USHORT Length;
  USHORT MaximumLength;
  PWSTR Buffer;
} ListName;

typedef struct {
  ULONG NextEntryOffset;
  ULONG NumberOfThreads;
  LARGE_INTEGER WorkingSetPrivateSize;
  ULONG HardFaultCount;
  ULONG NumberOfThreadsHighWatermark;
  ULONGLONG CycleTime;
  LARGE_INTEGER CreateTime;
  LARGE_INTEGER UserTime;
  LARGE_INTEGER KernelTime;
  ListName ImageName;
  LONG BasePriority;
  HANDLE UniqueProcessId;
  HANDLE InheritedFromUniqueProcessId;
} ListEntry;

typedef LONG(WINAPI* NtQuerySystemInformationFn)(ULONG, PVOID, ULONG, PULONG);
#define SYSTEM_PROCESS_INFORMATION_CLASS 5
#define STATUS_INFO_LENGTH_MISMATCH_VALUE 0xC0000004UL

typedef struct {
  PDH_HQUERY query;
  PDH_HCOUNTER dedicated;
  PDH_HCOUNTER shared;
  PDH_HCOUNTER engine;
  int open;
  int engineAdded;
  double lastCollectMs;
  const char* error;
  const char* engineError;
  double initMs;
} Gpu;

typedef struct {
  char* p;
  size_t n;
  size_t cap;
} Buf;

static LARGE_INTEGER qpcFreq;

static double nowMs(void) {
  LARGE_INTEGER t;
  QueryPerformanceCounter(&t);
  return (double)t.QuadPart * 1000.0 / (double)qpcFreq.QuadPart;
}

static ULONGLONG fileTimeValue(const FILETIME* ft) {
  return ((ULONGLONG)ft->dwHighDateTime << 32) | ft->dwLowDateTime;
}

static ULONGLONG unixMsNow(void) {
  FILETIME ft;
  GetSystemTimeAsFileTime(&ft);
  return (fileTimeValue(&ft) - EPOCH_DIFF_100NS) / 10000ULL;
}

static void bufReserve(Buf* b, size_t extra) {
  if (b->n + extra + 1 <= b->cap) return;
  size_t cap = b->cap ? b->cap : 4096;
  while (b->n + extra + 1 > cap) cap *= 2;
  char* next = (char*)realloc(b->p, cap);
  if (!next) {
    exit(5);
  }
  b->p = next;
  b->cap = cap;
}

static void bufPut(Buf* b, const char* s) {
  size_t len = strlen(s);
  bufReserve(b, len);
  memcpy(b->p + b->n, s, len);
  b->n += len;
  b->p[b->n] = 0;
}

static void bufPrintf(Buf* b, const char* fmt, ...) {
  char tmp[256];
  va_list args;
  va_start(args, fmt);
  int len = vsnprintf(tmp, sizeof(tmp), fmt, args);
  va_end(args);
  if (len < 0) return;
  if ((size_t)len >= sizeof(tmp)) len = (int)sizeof(tmp) - 1;
  tmp[len] = 0;
  bufPut(b, tmp);
}

// A JSON string from a file name: UTF-8, escaped.
static void bufJsonString(Buf* b, const WCHAR* s) {
  char utf8[MAX_PATH * 4];
  int len = WideCharToMultiByte(CP_UTF8, 0, s, -1, utf8, (int)sizeof(utf8), NULL, NULL);
  if (len <= 0) utf8[0] = 0;
  bufPut(b, "\"");
  for (const unsigned char* c = (const unsigned char*)utf8; *c; c++) {
    if (*c == '"' || *c == '\\') {
      char esc[3] = {'\\', (char)*c, 0};
      bufPut(b, esc);
    } else if (*c < 0x20) {
      bufPrintf(b, "\\u%04x", *c);
    } else {
      char one[2] = {(char)*c, 0};
      bufPut(b, one);
    }
  }
  bufPut(b, "\"");
}

static void bufNullableU64(Buf* b, const char* key, int have, ULONGLONG value) {
  if (have) bufPrintf(b, ",\"%s\":%llu", key, value);
  else bufPrintf(b, ",\"%s\":null", key);
}

static void addError(Proc* p, const char* code) {
  for (int i = 0; i < p->errorCount; i++) {
    if (strcmp(p->errors[i], code) == 0) return;
  }
  if (p->errorCount < MAX_ERRORS) p->errors[p->errorCount++] = code;
}

// The file name only (never a path), from a counted name.
static void copyExeName(WCHAR* dest, const ListName* src) {
  size_t chars = src->Buffer ? src->Length / sizeof(WCHAR) : 0;
  size_t start = 0;
  for (size_t i = 0; i < chars; i++) {
    if (src->Buffer[i] == L'\\' || src->Buffer[i] == L'/') start = i + 1;
  }
  size_t len = chars - start;
  if (len > MAX_PATH - 1) len = MAX_PATH - 1;
  if (len) memcpy(dest, src->Buffer + start, len * sizeof(WCHAR));
  dest[len] = 0;
}

// Clears what one sample reads, keeping the process's identity and handle.
static void resetSample(Proc* p) {
  size_t from = offsetof(Proc, exited);
  ZeroMemory((BYTE*)p + from, sizeof(Proc) - from);
}

static void readProcess(Proc* p) {
  if (!p->handle) {
    addError(p, "open_failed");
    return;
  }
  FILETIME created, exited, kernelTime, userTime;
  if (GetProcessTimes(p->handle, &created, &exited, &kernelTime, &userTime)) {
    p->haveCreated = 1;
    p->created = fileTimeValue(&created);
    p->haveTimes = 1;
    p->cpu100ns = fileTimeValue(&kernelTime) + fileTimeValue(&userTime);
    // A stream keeps handles between listings: a process that exited since is dropped.
    if (fileTimeValue(&exited) != 0) {
      p->exited = 1;
      return;
    }
  } else {
    addError(p, "times_failed");
  }

  PROCESS_MEMORY_COUNTERS_EX pmc;
  ZeroMemory(&pmc, sizeof(pmc));
  pmc.cb = sizeof(pmc);
  if (GetProcessMemoryInfo(p->handle, (PROCESS_MEMORY_COUNTERS*)&pmc, sizeof(pmc))) {
    p->haveMem = 1;
    p->ws = pmc.WorkingSetSize;
    p->priv = pmc.PrivateUsage;
    p->peak = pmc.PeakWorkingSetSize;
  } else {
    addError(p, "memory_failed");
  }

  DWORD handles = 0;
  if (GetProcessHandleCount(p->handle, &handles)) {
    p->haveHandles = 1;
    p->handles = handles;
  } else {
    addError(p, "handles_failed");
  }

  // 0 is a real count; a failure also returns 0, with the last error set.
  SetLastError(0);
  DWORD gdi = GetGuiResources(p->handle, GR_GDIOBJECTS);
  if (gdi != 0 || GetLastError() == 0) {
    p->haveGdi = 1;
    p->gdi = gdi;
  } else {
    addError(p, "gdi_failed");
  }
  SetLastError(0);
  DWORD user = GetGuiResources(p->handle, GR_USEROBJECTS);
  if (user != 0 || GetLastError() == 0) {
    p->haveUser = 1;
    p->user = user;
  } else {
    addError(p, "user_failed");
  }
}

static int findProc(Proc* procs, int count, DWORD pid) {
  for (int i = 0; i < count; i++) {
    if (procs[i].pid == pid) return i;
  }
  return -1;
}

static void closeProcs(Proc* procs, int count) {
  for (int i = 0; i < count; i++) {
    if (procs[i].handle) CloseHandle(procs[i].handle);
    procs[i].handle = NULL;
  }
}

static BYTE* listBuffer = NULL;
// 1.8 MB held 813 processes and 15,400 threads; a short buffer costs a second
// full listing, and pages the kernel doesn't write are never touched.
static ULONG listBufferSize = 4 << 20;

// Every process on this PC into listBuffer, kept between a stream's samples.
static int listProcesses(void) {
  static NtQuerySystemInformationFn query = NULL;
  if (!query) {
    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    query = ntdll ? (NtQuerySystemInformationFn)(void*)GetProcAddress(
                        ntdll, "NtQuerySystemInformation")
                  : NULL;
    if (!query) return 0;
  }
  for (int attempt = 0; attempt < 4; attempt++) {
    if (!listBuffer) {
      listBuffer = (BYTE*)malloc(listBufferSize);
      if (!listBuffer) return 0;
    }
    ULONG needed = 0;
    LONG status = query(SYSTEM_PROCESS_INFORMATION_CLASS, listBuffer, listBufferSize, &needed);
    if (status >= 0) return 1;
    if ((ULONG)status != STATUS_INFO_LENGTH_MISMATCH_VALUE) return 0;
    free(listBuffer);
    listBuffer = NULL;
    // Processes start between calls: leave room for them.
    listBufferSize = (needed > listBufferSize ? needed : listBufferSize * 2) + 256 * 1024;
  }
  return 0;
}

static const ListEntry* nextEntry(const ListEntry* e) {
  return e->NextEntryOffset ? (const ListEntry*)((const BYTE*)e + e->NextEntryOffset) : NULL;
}

static DWORD entryPid(const ListEntry* e) {
  return (DWORD)(ULONG_PTR)e->UniqueProcessId;
}

static void addFromList(Proc* p, const ListEntry* e) {
  ZeroMemory(p, sizeof(*p));
  p->pid = entryPid(e);
  p->ppid = (DWORD)(ULONG_PTR)e->InheritedFromUniqueProcessId;
  p->threads = e->NumberOfThreads;
  copyExeName(p->exe, &e->ImageName);
  p->haveCreated = 1;
  p->created = (ULONGLONG)e->CreateTime.QuadPart;
  p->handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, p->pid);
}

// The tree under root, root first. A child counts only if it started after
// its parent: a parent id can be reused by an unrelated process once the real
// parent has exited. Returns the count, or -1 (listing failed) / -2 (no root).
static int collectTree(DWORD root, DWORD self, Proc* procs, int max) {
  if (!listProcesses()) return -1;
  const ListEntry* first = (const ListEntry*)listBuffer;

  int count = 0;
  for (const ListEntry* e = first; e; e = nextEntry(e)) {
    if (entryPid(e) != root) continue;
    addFromList(&procs[count++], e);
    break;
  }
  if (count == 0) return -2;

  for (int parent = 0; parent < count; parent++) {
    for (const ListEntry* e = first; e && count < max; e = nextEntry(e)) {
      DWORD pid = entryPid(e);
      DWORD ppid = (DWORD)(ULONG_PTR)e->InheritedFromUniqueProcessId;
      if (ppid != procs[parent].pid || pid == self || pid == ppid) continue;
      if ((ULONGLONG)e->CreateTime.QuadPart < procs[parent].created) continue;
      if (findProc(procs, count, pid) >= 0) continue;
      addFromList(&procs[count++], e);
    }
  }
  return count;
}

static void gpuClose(Gpu* g) {
  if (g->open) PdhCloseQuery(g->query);
  g->open = 0;
}

// The once mode collects here (memory counters are raw values: one collect is
// enough); a stream collects at every sample instead.
static int gpuInit(Gpu* g, int withEngine, int collectNow) {
  double start = nowMs();
  ZeroMemory(g, sizeof(*g));
  if (PdhOpenQueryW(NULL, 0, &g->query) != ERROR_SUCCESS) {
    g->error = "pdh_open_failed";
    return 0;
  }
  g->open = 1;
  if (PdhAddEnglishCounterW(g->query, L"\\GPU Process Memory(*)\\Dedicated Usage", 0,
                            &g->dedicated) != ERROR_SUCCESS ||
      PdhAddEnglishCounterW(g->query, L"\\GPU Process Memory(*)\\Shared Usage", 0,
                            &g->shared) != ERROR_SUCCESS) {
    g->error = "pdh_add_failed";
    gpuClose(g);
    return 0;
  }
  if (withEngine) {
    if (PdhAddEnglishCounterW(g->query, L"\\GPU Engine(*)\\Utilization Percentage", 0,
                              &g->engine) == ERROR_SUCCESS) {
      g->engineAdded = 1;
    } else {
      g->engineError = "pdh_engine_add_failed";
    }
  }
  if (collectNow && PdhCollectQueryData(g->query) != ERROR_SUCCESS) {
    g->error = "pdh_collect_failed";
  }
  g->initMs = nowMs() - start;
  return g->error == NULL;
}

// Returns 1 when engine rates from this collect span at least a second.
static int gpuCollect(Gpu* g, int* engineIntervalOk) {
  *engineIntervalOk = 0;
  if (!g->open) return 0;
  double at = nowMs();
  if (PdhCollectQueryData(g->query) != ERROR_SUCCESS) {
    g->error = "pdh_collect_failed";
    g->lastCollectMs = 0;
    return 0;
  }
  g->error = NULL;
  *engineIntervalOk = g->lastCollectMs > 0 && at - g->lastCollectMs >= MIN_INTERVAL_MS - 50;
  g->lastCollectMs = at;
  return 1;
}

// Every instance of a wildcard counter, formatted; NULL when none could be read.
static PDH_FMT_COUNTERVALUE_ITEM_W* readCounterArray(PDH_HCOUNTER counter, DWORD format,
                                                      DWORD* count) {
  DWORD size = 0;
  *count = 0;
  PDH_STATUS status = PdhGetFormattedCounterArrayW(counter, format, &size, count, NULL);
  if (status != PDH_MORE_DATA || size == 0) return NULL;
  PDH_FMT_COUNTERVALUE_ITEM_W* items = (PDH_FMT_COUNTERVALUE_ITEM_W*)malloc(size);
  if (!items) return NULL;
  status = PdhGetFormattedCounterArrayW(counter, format, &size, count, items);
  if (status != ERROR_SUCCESS) {
    free(items);
    *count = 0;
    return NULL;
  }
  return items;
}

static int validStatus(DWORD status) {
  return status == PDH_CSTATUS_VALID_DATA || status == PDH_CSTATUS_NEW_DATA;
}

// "pid_1234_luid_0x00000000_0x0000D1E2_phys_0[_eng_3_engtype_3D]"
static int parseInstance(const WCHAR* name, DWORD* pid, DWORD* luidHigh, DWORD* luidLow,
                         DWORD* phys) {
  unsigned long a = 0, b = 0, c = 0, d = 0;
  if (swscanf(name, L"pid_%lu_luid_0x%lx_0x%lx_phys_%lu", &a, &b, &c, &d) != 4) return 0;
  *pid = (DWORD)a;
  *luidHigh = (DWORD)b;
  *luidLow = (DWORD)c;
  *phys = (DWORD)d;
  return 1;
}

static int compareDword(const void* a, const void* b) {
  DWORD x = *(const DWORD*)a;
  DWORD y = *(const DWORD*)b;
  return x < y ? -1 : x > y ? 1 : 0;
}

// Graphics memory per process in the tree, and the PC-wide count of processes
// holding dedicated memory (distinct PIDs, every adapter). -1 when unreadable.
static long readGpuMemory(Gpu* g, Proc* procs, int count) {
  DWORD dedicatedCount = 0;
  PDH_FMT_COUNTERVALUE_ITEM_W* dedicated =
      readCounterArray(g->dedicated, PDH_FMT_LARGE, &dedicatedCount);
  if (!dedicated) return -1;

  DWORD* holders = (DWORD*)malloc(sizeof(DWORD) * (dedicatedCount ? dedicatedCount : 1));
  DWORD holderCount = 0;
  for (DWORD i = 0; i < dedicatedCount; i++) {
    if (!validStatus(dedicated[i].FmtValue.CStatus)) continue;
    DWORD pid, hi, lo, phys;
    if (!parseInstance(dedicated[i].szName, &pid, &hi, &lo, &phys)) continue;
    LONGLONG value = dedicated[i].FmtValue.largeValue;
    if (value > 0 && holders) holders[holderCount++] = pid;
    int index = findProc(procs, count, pid);
    if (index >= 0 && value > 0) procs[index].gpuDedicated += (ULONGLONG)value;
  }
  free(dedicated);

  long distinct = 0;
  if (holders) {
    qsort(holders, holderCount, sizeof(DWORD), compareDword);
    for (DWORD i = 0; i < holderCount; i++) {
      if (i == 0 || holders[i] != holders[i - 1]) distinct++;
    }
    free(holders);
  }

  DWORD sharedCount = 0;
  PDH_FMT_COUNTERVALUE_ITEM_W* shared = readCounterArray(g->shared, PDH_FMT_LARGE, &sharedCount);
  if (shared) {
    for (DWORD i = 0; i < sharedCount; i++) {
      if (!validStatus(shared[i].FmtValue.CStatus)) continue;
      DWORD pid, hi, lo, phys;
      if (!parseInstance(shared[i].szName, &pid, &hi, &lo, &phys)) continue;
      int index = findProc(procs, count, pid);
      LONGLONG value = shared[i].FmtValue.largeValue;
      if (index >= 0 && value > 0) procs[index].gpuShared += (ULONGLONG)value;
    }
    free(shared);
  }
  return distinct;
}

// Each process's busiest 3D engine: instances of one engine (adapter LUID,
// physical adapter, engine index) are summed, then the highest is kept.
// Returns 1 when the engine counter gave valid rates this sample.
static int readGpuEngines(Gpu* g, Proc* procs, int count) {
  if (!g->engineAdded) return 0;
  DWORD itemCount = 0;
  PDH_FMT_COUNTERVALUE_ITEM_W* items =
      readCounterArray(g->engine, PDH_FMT_DOUBLE | PDH_FMT_NOCAP100, &itemCount);
  if (!items) return 0;
  int anyValid = 0;
  for (DWORD i = 0; i < itemCount; i++) {
    if (!validStatus(items[i].FmtValue.CStatus)) continue;
    anyValid = 1;
    const WCHAR* name = items[i].szName;
    size_t len = wcslen(name);
    const WCHAR* suffix = L"_engtype_3D";
    size_t suffixLen = wcslen(suffix);
    if (len < suffixLen || wcscmp(name + len - suffixLen, suffix) != 0) continue;
    DWORD pid, hi, lo, phys;
    if (!parseInstance(name, &pid, &hi, &lo, &phys)) continue;
    int index = findProc(procs, count, pid);
    if (index < 0) continue;
    const WCHAR* engPart = wcsstr(name, L"_eng_");
    unsigned long eng = 0;
    if (!engPart || swscanf(engPart, L"_eng_%lu", &eng) != 1) continue;
    Proc* p = &procs[index];
    int slot = -1;
    for (int s = 0; s < p->engineCount; s++) {
      EngineSlot* e = &p->engines[s];
      if (e->luidHigh == hi && e->luidLow == lo && e->phys == phys && e->eng == (DWORD)eng) {
        slot = s;
        break;
      }
    }
    if (slot < 0 && p->engineCount < MAX_ENGINES) {
      slot = p->engineCount++;
      p->engines[slot].luidHigh = hi;
      p->engines[slot].luidLow = lo;
      p->engines[slot].phys = phys;
      p->engines[slot].eng = (DWORD)eng;
      p->engines[slot].sum = 0;
    }
    if (slot >= 0) p->engines[slot].sum += items[i].FmtValue.doubleValue;
  }
  free(items);
  return anyValid;
}

static double busiestEngine(const Proc* p) {
  double best = 0;
  for (int s = 0; s < p->engineCount; s++) {
    if (p->engines[s].sum > best) best = p->engines[s].sum;
  }
  return best;
}

static double selfCpuMs(void) {
  FILETIME created, exited, kernel, user;
  if (!GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user)) return -1;
  return (double)(fileTimeValue(&kernel) + fileTimeValue(&user)) / 10000.0;
}

static int writeAll(const char* data, size_t len) {
  HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
  while (len > 0) {
    DWORD written = 0;
    if (!WriteFile(out, data, (DWORD)len, &written, NULL) || written == 0) return 0;
    data += written;
    len -= written;
  }
  return 1;
}

static int printError(const char* mode, const char* code) {
  Buf b = {0};
  bufPrintf(&b, "{\"v\":1,\"mode\":\"%s\",\"error\":\"%s\"}\n", mode, code);
  int ok = writeAll(b.p, b.n);
  free(b.p);
  return ok;
}

// The tree under --root, kept between a stream's samples: an open handle keeps
// its process's PID from being reused, so only a new child needs a listing.
static Proc procs[MAX_PROCS];
static int procCount = 0;

// One sample as one JSON line; `relist` walks the process list again (always
// for --once, every LIST_EVERY samples for --stream). Returns 0 when stdout is
// gone, -2 when the root is gone, -1 when the process listing failed.
static int sampleOnce(const char* mode, DWORD root, int wantGpu, Gpu* g, int gpuReady,
                      int relist) {
  double start = nowMs();
  DWORD self = GetCurrentProcessId();
  if (relist || procCount == 0) {
    closeProcs(procs, procCount);
    procCount = 0;
    int listed = collectTree(root, self, procs, MAX_PROCS);
    if (listed == -1) return printError(mode, "list_failed") ? -1 : 0;
    if (listed == -2) return printError(mode, "root_not_found") ? -2 : 0;
    procCount = listed;
  }

  for (int i = 0; i < procCount; i++) {
    resetSample(&procs[i]);
    readProcess(&procs[i]);
  }
  if (procs[0].exited) return printError(mode, "root_not_found") ? -2 : 0;
  int kept = 0;
  for (int i = 0; i < procCount; i++) {
    if (procs[i].exited) {
      if (procs[i].handle) CloseHandle(procs[i].handle);
      continue;
    }
    if (kept != i) procs[kept] = procs[i];
    kept++;
  }
  procCount = kept;
  int count = procCount;

  long holders = -1;
  int engineValid = 0;
  const char* gpuError = NULL;
  if (wantGpu) {
    int engineIntervalOk = 0;
    if (!gpuReady) {
      gpuError = g->error ? g->error : "pdh_unavailable";
    } else if (strcmp(mode, "stream") == 0 && !gpuCollect(g, &engineIntervalOk)) {
      gpuError = g->error;
    }
    if (!gpuError) {
      holders = readGpuMemory(g, procs, count);
      if (holders < 0) gpuError = "pdh_no_data";
      else if (engineIntervalOk) engineValid = readGpuEngines(g, procs, count);
    }
  }
  int gpuOk = wantGpu && !gpuError;

  Buf b = {0};
  bufPrintf(&b, "{\"v\":1,\"mode\":\"%s\",\"root\":%lu,\"self\":%lu,\"at\":%llu", mode,
            (unsigned long)root, (unsigned long)self, unixMsNow());
  bufPut(&b, ",\"gpu\":{");
  if (!wantGpu) {
    bufPut(&b, "\"status\":\"off\",\"error\":null,\"processesWithDedicated\":null");
  } else if (!gpuOk) {
    bufPrintf(&b, "\"status\":\"failed\",\"error\":\"%s\",\"processesWithDedicated\":null",
              gpuError);
  } else {
    bufPrintf(&b, "\"status\":\"ok\",\"error\":null,\"processesWithDedicated\":%ld", holders);
  }
  if (!gpuOk || !g->engineAdded) {
    bufPrintf(&b, ",\"engine\":\"%s\"",
              gpuOk && g->engineError ? "failed" : "off");
  } else {
    bufPrintf(&b, ",\"engine\":\"%s\"", engineValid ? "ok" : "pending");
  }
  bufPut(&b, "}");
  if (wantGpu && g->initMs > 0) bufPrintf(&b, ",\"pdhInitMs\":%.1f", g->initMs);
  else bufPut(&b, ",\"pdhInitMs\":null");

  bufPut(&b, ",\"processes\":[");
  for (int i = 0; i < count; i++) {
    Proc* p = &procs[i];
    if (i) bufPut(&b, ",");
    bufPrintf(&b, "{\"pid\":%lu,\"ppid\":%lu,\"exe\":", (unsigned long)p->pid,
              (unsigned long)p->ppid);
    bufJsonString(&b, p->exe);
    if (p->haveCreated) {
      bufPrintf(&b, ",\"createdAt\":%llu", (p->created - EPOCH_DIFF_100NS) / 10000ULL);
    } else {
      bufPut(&b, ",\"createdAt\":null");
    }
    if (p->haveTimes) bufPrintf(&b, ",\"cpuSec\":%.3f", (double)p->cpu100ns / 1e7);
    else bufPut(&b, ",\"cpuSec\":null");
    bufNullableU64(&b, "ws", p->haveMem, p->ws);
    bufNullableU64(&b, "priv", p->haveMem, p->priv);
    bufNullableU64(&b, "peak", p->haveMem, p->peak);
    bufNullableU64(&b, "handles", p->haveHandles, p->handles);
    bufPrintf(&b, ",\"threads\":%lu", (unsigned long)p->threads);
    bufNullableU64(&b, "gdi", p->haveGdi, p->gdi);
    bufNullableU64(&b, "user", p->haveUser, p->user);
    bufNullableU64(&b, "gpuDedicated", gpuOk, p->gpuDedicated);
    bufNullableU64(&b, "gpuShared", gpuOk, p->gpuShared);
    if (gpuOk && engineValid) bufPrintf(&b, ",\"gpuUse\":%.2f", busiestEngine(p));
    else bufPut(&b, ",\"gpuUse\":null");
    bufPut(&b, ",\"errors\":[");
    for (int e = 0; e < p->errorCount; e++) {
      bufPrintf(&b, "%s\"%s\"", e ? "," : "", p->errors[e]);
    }
    bufPut(&b, "]}");
  }
  bufPut(&b, "]");
  bufPrintf(&b, ",\"sampleMs\":%.1f,\"selfCpuMs\":%.1f}\n", nowMs() - start, selfCpuMs());

  int ok = writeAll(b.p, b.n);
  free(b.p);
  return ok ? 1 : 0;
}

static HANDLE stopEvent;

// stdin closing (the app quit, or stopped the stream) ends the stream.
static DWORD WINAPI watchStdin(LPVOID unused) {
  (void)unused;
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  char buffer[256];
  DWORD read = 0;
  while (in && in != INVALID_HANDLE_VALUE && ReadFile(in, buffer, sizeof(buffer), &read, NULL) &&
         read > 0) {
  }
  SetEvent(stopEvent);
  return 0;
}

static int parseDword(const char* s, DWORD* out) {
  char* end = NULL;
  unsigned long value = strtoul(s, &end, 10);
  if (!s[0] || (end && *end) || value == 0 || value > 0xFFFFFFFFUL) return 0;
  *out = (DWORD)value;
  return 1;
}

// Windows gives a console program a console (a conhost.exe) even when it's
// started hidden with piped stdio. Started that way, release it; the pipes keep
// working. Run by hand in a terminal, stdout is the console and stays.
static void releaseConsoleWhenPiped(void) {
  if (GetFileType(GetStdHandle(STD_OUTPUT_HANDLE)) != FILE_TYPE_CHAR) FreeConsole();
}

int main(int argc, char** argv) {
  releaseConsoleWhenPiped();
  QueryPerformanceFrequency(&qpcFreq);
  int once = 0, stream = 0, wantGpu = 0;
  DWORD root = 0;
  DWORD interval = DEFAULT_INTERVAL_MS;
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--once") == 0) once = 1;
    else if (strcmp(argv[i], "--stream") == 0) stream = 1;
    else if (strcmp(argv[i], "--gpu") == 0) wantGpu = 1;
    else if (strcmp(argv[i], "--root") == 0 && i + 1 < argc) {
      if (!parseDword(argv[++i], &root)) root = 0;
    } else if (strcmp(argv[i], "--interval") == 0 && i + 1 < argc) {
      if (!parseDword(argv[++i], &interval)) interval = 0;
    } else {
      root = 0;
      break;
    }
  }
  const char* mode = stream ? "stream" : "once";
  if (once == stream || root == 0 || interval == 0) {
    printError(mode, "bad_args");
    return 2;
  }
  if (interval < MIN_INTERVAL_MS) interval = MIN_INTERVAL_MS;

  Gpu gpu;
  ZeroMemory(&gpu, sizeof(gpu));
  int gpuReady = 0;
  if (wantGpu) gpuReady = gpuInit(&gpu, stream, once);

  if (once) {
    int result = sampleOnce(mode, root, wantGpu, &gpu, gpuReady, 1);
    gpuClose(&gpu);
    return result == -2 ? 3 : result == -1 ? 4 : 0;
  }

  stopEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  HANDLE watcher = CreateThread(NULL, 0, watchStdin, NULL, 0, NULL);
  HANDLE rootProcess = OpenProcess(SYNCHRONIZE, FALSE, root);
  HANDLE waits[2];
  DWORD waitCount = 0;
  waits[waitCount++] = stopEvent;
  if (rootProcess) waits[waitCount++] = rootProcess;

  int exitCode = 0;
  for (unsigned long sample = 0;; sample++) {
    int result = sampleOnce(mode, root, wantGpu, &gpu, gpuReady, sample % LIST_EVERY == 0);
    if (result <= 0) {
      exitCode = result == -2 ? 3 : result == -1 ? 4 : 0;
      break;
    }
    if (WaitForMultipleObjects(waitCount, waits, FALSE, interval) != WAIT_TIMEOUT) break;
  }
  gpuClose(&gpu);
  if (rootProcess) CloseHandle(rootProcess);
  (void)watcher;
  return exitCode;
}
