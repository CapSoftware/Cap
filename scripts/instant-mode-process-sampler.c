#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <mach/mach_time.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/proc_info.h>
#include <sys/resource.h>
#include <time.h>
#include <unistd.h>

#define MAX_PIDS 64

struct process_sample {
	struct rusage_info_v6 usage;
	struct proc_taskinfo task;
	bool valid;
};

static double elapsed_seconds(struct timespec start, struct timespec end) {
	return (double)(end.tv_sec - start.tv_sec) +
		(double)(end.tv_nsec - start.tv_nsec) / 1000000000.0;
}

static struct process_sample read_sample(pid_t pid) {
	struct process_sample sample = {0};
	int task_bytes = proc_pidinfo(
		pid,
		PROC_PIDTASKINFO,
		0,
		&sample.task,
		(int)sizeof(sample.task)
	);
	sample.valid =
		proc_pid_rusage(
			pid,
			RUSAGE_INFO_V6,
			(rusage_info_t *)&sample.usage
		) == 0 &&
		task_bytes == (int)sizeof(sample.task);
	return sample;
}

static uint64_t absolute_time_to_nanoseconds(uint64_t value) {
	static mach_timebase_info_data_t timebase = {0};
	if (timebase.denom == 0) {
		mach_timebase_info(&timebase);
	}
	return (uint64_t)(
		(__uint128_t)value * timebase.numer / timebase.denom
	);
}

static uint64_t user_time_nanoseconds(const struct process_sample *sample) {
	uint64_t value = sample->usage.ri_user_time != 0
		? sample->usage.ri_user_time
		: sample->task.pti_total_user;
	return absolute_time_to_nanoseconds(value);
}

static uint64_t system_time_nanoseconds(const struct process_sample *sample) {
	uint64_t value = sample->usage.ri_system_time != 0
		? sample->usage.ri_system_time
		: sample->task.pti_total_system;
	return absolute_time_to_nanoseconds(value);
}

static uint64_t resident_size(const struct process_sample *sample) {
	return sample->usage.ri_resident_size != 0
		? sample->usage.ri_resident_size
		: sample->task.pti_resident_size;
}

static uint64_t physical_footprint(const struct process_sample *sample) {
	return sample->usage.ri_phys_footprint != 0
		? sample->usage.ri_phys_footprint
		: resident_size(sample);
}

static void print_sample(
	unsigned long sample_index,
	double elapsed,
	double interval,
	pid_t pid,
	const struct process_sample *current,
	const struct process_sample *previous
) {
	char name[PROC_PIDPATHINFO_MAXSIZE] = {0};
	if (proc_name(pid, name, sizeof(name)) <= 0) {
		snprintf(name, sizeof(name), "pid-%d", pid);
	}
	uint64_t current_user_time = user_time_nanoseconds(current);
	uint64_t current_system_time = system_time_nanoseconds(current);
	uint64_t cpu_delta =
		current_user_time - user_time_nanoseconds(previous) +
		current_system_time - system_time_nanoseconds(previous);
	double cpu_percent = interval > 0.0
		? ((double)cpu_delta / 1000000000.0) / interval * 100.0
		: 0.0;
	printf(
		"%lu,%.6f,%d,%s,%" PRIu64 ",%" PRIu64 ",%.6f,%" PRIu64
		",%" PRIu64 ",%" PRIu64 ",%" PRIu64 ",%" PRIu64 ",%" PRIu64
		",%" PRIu64 ",%" PRIu64 ",%" PRIu64 ",%" PRIu64 ",%" PRIu64
		",%" PRIu64 ",%" PRIu64 ",%" PRIu64 ",%d,%d,%d,%d,%d\n",
		sample_index,
		elapsed,
		pid,
		name,
		current_user_time,
		current_system_time,
		cpu_percent,
		resident_size(current),
		physical_footprint(current),
		current->usage.ri_lifetime_max_phys_footprint,
		current->usage.ri_neural_footprint,
		current->usage.ri_energy_nj,
		current->usage.ri_diskio_bytesread,
		current->usage.ri_diskio_byteswritten,
		current->usage.ri_logical_writes,
		current->usage.ri_pageins,
		current->usage.ri_pkg_idle_wkups,
		current->usage.ri_interrupt_wkups,
		current->usage.ri_instructions,
		current->usage.ri_cycles,
		absolute_time_to_nanoseconds(current->usage.ri_runnable_time),
		current->task.pti_threadnum,
		current->task.pti_csw,
		current->task.pti_syscalls_mach,
		current->task.pti_syscalls_unix,
		current->task.pti_faults
	);
}

int main(int argc, char **argv) {
	if (argc < 4) {
		fprintf(stderr, "usage: %s duration_seconds interval_ms pid...\n", argv[0]);
		return 2;
	}

	char *duration_end = NULL;
	char *interval_end = NULL;
	errno = 0;
	double duration_seconds = strtod(argv[1], &duration_end);
	long interval_ms = strtol(argv[2], &interval_end, 10);
	int pid_count = argc - 3;
	if (
		errno != 0 ||
		duration_end == argv[1] ||
		*duration_end != '\0' ||
		interval_end == argv[2] ||
		*interval_end != '\0' ||
		duration_seconds <= 0.0 ||
		interval_ms <= 0 ||
		pid_count > MAX_PIDS
	) {
		return 2;
	}

	pid_t pids[MAX_PIDS] = {0};
	struct process_sample previous[MAX_PIDS] = {0};
	for (int index = 0; index < pid_count; index++) {
		char *pid_end = NULL;
		long parsed_pid = strtol(argv[index + 3], &pid_end, 10);
		if (
			pid_end == argv[index + 3] ||
			*pid_end != '\0' ||
			parsed_pid <= 0
		) {
			return 2;
		}
		pids[index] = (pid_t)parsed_pid;
		previous[index] = read_sample(pids[index]);
	}

	printf(
		"sample,elapsed_s,pid,name,user_ns,system_ns,cpu_pct,rss_bytes,"
		"phys_footprint_bytes,max_phys_footprint_bytes,neural_footprint_bytes,"
		"energy_nj,disk_read_bytes,disk_write_bytes,logical_writes,pageins,"
		"idle_wakeups,interrupt_wakeups,instructions,cycles,runnable_ns,"
		"threads,context_switches,mach_syscalls,unix_syscalls,faults\n"
	);
	fflush(stdout);

	struct timespec started = {0};
	struct timespec previous_time = {0};
	clock_gettime(CLOCK_MONOTONIC, &started);
	previous_time = started;
	unsigned long total_samples =
		(unsigned long)((duration_seconds * 1000.0) / (double)interval_ms);
	if ((double)total_samples * (double)interval_ms < duration_seconds * 1000.0) {
		total_samples++;
	}

	for (unsigned long sample_index = 1; sample_index <= total_samples; sample_index++) {
		struct timespec requested = {
			.tv_sec = interval_ms / 1000,
			.tv_nsec = (interval_ms % 1000) * 1000000,
		};
		struct timespec remaining = {0};
		while (nanosleep(&requested, &remaining) == -1 && errno == EINTR) {
			requested = remaining;
		}

		struct timespec now = {0};
		clock_gettime(CLOCK_MONOTONIC, &now);
		double interval = elapsed_seconds(previous_time, now);
		double elapsed = elapsed_seconds(started, now);
		for (int index = 0; index < pid_count; index++) {
			struct process_sample current = read_sample(pids[index]);
			if (current.valid && previous[index].valid) {
				print_sample(
					sample_index,
					elapsed,
					interval,
					pids[index],
					&current,
					&previous[index]
				);
			}
			previous[index] = current;
		}
		fflush(stdout);
		previous_time = now;
	}

	return 0;
}
