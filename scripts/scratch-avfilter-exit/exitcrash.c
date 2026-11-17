#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef void *(__cdecl *malloc_fn)(size_t);
typedef void(__cdecl *free_fn)(void *);
typedef void *(*graph_alloc_fn)(void);
typedef void (*graph_free_fn)(void **);
typedef intptr_t(__cdecl *heap_handle_fn)(void);

static malloc_fn crt_malloc;
static free_fn crt_free;
static volatile LONG running = 1;

static DWORD WINAPI hammer_msvcrt(LPVOID arg) {
	void *slots[64] = {0};
	unsigned i = (unsigned)(uintptr_t)arg;
	while (running) {
		unsigned k = i++ & 63;
		if (slots[k]) crt_free(slots[k]);
		slots[k] = crt_malloc(16 + (i * 37) % 4000);
	}
	for (int k = 0; k < 64; k++) if (slots[k]) crt_free(slots[k]);
	return 0;
}

static DWORD WINAPI hammer_ucrt(LPVOID arg) {
	void *slots[64] = {0};
	unsigned i = (unsigned)(uintptr_t)arg;
	while (running) {
		unsigned k = i++ & 63;
		free(slots[k]);
		slots[k] = malloc(16 + (i * 37) % 4000);
	}
	for (int k = 0; k < 64; k++) free(slots[k]);
	return 0;
}

int main(int argc, char **argv) {
	if (argc < 6) {
		fprintf(stderr, "usage: exitcrash <ffmpeg-bin-dir> <none|msvcrt|ucrt> <threads> <return|terminate|join> <wer|nower> [info]\n");
		return 91;
	}
	const char *dir = argv[1];
	const char *kind = argv[2];
	int threads = atoi(argv[3]);
	const char *exit_kind = argv[4];
	UINT mode = SEM_FAILCRITICALERRORS | SEM_NOOPENFILEERRORBOX;
	if (strcmp(argv[5], "nower") == 0) mode |= SEM_NOGPFAULTERRORBOX;
	SetErrorMode(mode);

	SetDllDirectoryA(dir);
	char path[MAX_PATH];
	snprintf(path, sizeof path, "%s\\avfilter-10.dll", dir);
	HMODULE avfilter = LoadLibraryExA(path, NULL, LOAD_WITH_ALTERED_SEARCH_PATH);
	if (!avfilter) {
		fprintf(stderr, "LoadLibrary %s failed %lu\n", path, GetLastError());
		return 90;
	}
	graph_alloc_fn graph_alloc = (graph_alloc_fn)GetProcAddress(avfilter, "avfilter_graph_alloc");
	graph_free_fn graph_free = (graph_free_fn)GetProcAddress(avfilter, "avfilter_graph_free");
	void *graph = graph_alloc();
	graph_free(&graph);

	HMODULE msvcrt = GetModuleHandleA("msvcrt.dll");
	crt_malloc = (malloc_fn)GetProcAddress(msvcrt, "malloc");
	crt_free = (free_fn)GetProcAddress(msvcrt, "free");
	if (argc > 6 && strcmp(argv[6], "info") == 0) {
		heap_handle_fn get_heap = (heap_handle_fn)GetProcAddress(msvcrt, "_get_heap_handle");
		printf("process heap %p, msvcrt heap %p, ucrt heap %p\n", GetProcessHeap(),
		       get_heap ? (void *)get_heap() : NULL, (void *)_get_heap_handle());
	}

	HANDLE handles[64];
	int started = 0;
	LPTHREAD_START_ROUTINE fn = NULL;
	if (strcmp(kind, "msvcrt") == 0) fn = hammer_msvcrt;
	if (strcmp(kind, "ucrt") == 0) fn = hammer_ucrt;
	if (fn) {
		for (; started < threads && started < 64; started++)
			handles[started] = CreateThread(NULL, 0, fn, (LPVOID)(uintptr_t)(started * 7919), 0, NULL);
		Sleep(5 + GetTickCount() % 16);
	}

	fflush(stdout);
	if (strcmp(exit_kind, "terminate") == 0) TerminateProcess(GetCurrentProcess(), 0);
	if (strcmp(exit_kind, "join") == 0 && started) {
		InterlockedExchange(&running, 0);
		WaitForMultipleObjects(started, handles, TRUE, INFINITE);
	}
	return 0;
}
