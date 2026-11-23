#pragma once
#define M_PI 3.14159265358979323846
#define M_LN2 0.69314718055994530942
#define INFINITY __builtin_inff()
#define NAN __builtin_nanf("")
double sqrt(double x); float sqrtf(float x);
double exp(double x); float expf(float x);
double log(double x); float logf(float x);
double log10(double x); float log10f(float x);
double pow(double x, double y); float powf(float x, float y);
double floor(double x); float floorf(float x);
double ceil(double x); float ceilf(float x);
double cos(double x); float cosf(float x);
double sin(double x); float sinf(float x);
double tanh(double x); float tanhf(float x);
double atan(double x); float atanf(float x);
double atan2(double y, double x); float atan2f(float y, float x);
double fabs(double x); float fabsf(float x);
double fmax(double a, double b); float fmaxf(float a, float b);
double fmin(double a, double b); float fminf(float a, float b);
long lrint(double x); long lrintf(float x);
double rint(double x); float rintf(float x);
double floor(double x);
double exp2(double x); float exp2f(float x);
double log2(double x); float log2f(float x);
