
#ifdef HAVE_CONFIG_H
#include "config.h"
#endif

#include "rnnoise_data.h"





















































#ifndef DUMP_BINARY_WEIGHTS
int init_rnnoise(RNNoise *model, const WeightArray *arrays) {
    if (linear_init(&model->conv1, arrays, "conv1_bias", NULL, NULL,"conv1_weights_float", NULL, NULL, NULL, 195, 128)) return 1;
    if (linear_init(&model->conv2, arrays, "conv2_bias", "conv2_subias", "conv2_weights_int8","conv2_weights_float", NULL, NULL, "conv2_scale", 384, 384)) return 1;
    if (linear_init(&model->gru1_input, arrays, "gru1_input_bias", "gru1_input_subias", "gru1_input_weights_int8","gru1_input_weights_float", "gru1_input_weights_idx", NULL, "gru1_input_scale", 384, 1152)) return 1;
    if (linear_init(&model->gru1_recurrent, arrays, "gru1_recurrent_bias", "gru1_recurrent_subias", "gru1_recurrent_weights_int8","gru1_recurrent_weights_float", "gru1_recurrent_weights_idx", "gru1_recurrent_weights_diag", "gru1_recurrent_scale", 384, 1152)) return 1;
    if (linear_init(&model->gru2_input, arrays, "gru2_input_bias", "gru2_input_subias", "gru2_input_weights_int8","gru2_input_weights_float", "gru2_input_weights_idx", NULL, "gru2_input_scale", 384, 1152)) return 1;
    if (linear_init(&model->gru2_recurrent, arrays, "gru2_recurrent_bias", "gru2_recurrent_subias", "gru2_recurrent_weights_int8","gru2_recurrent_weights_float", "gru2_recurrent_weights_idx", "gru2_recurrent_weights_diag", "gru2_recurrent_scale", 384, 1152)) return 1;
    if (linear_init(&model->gru3_input, arrays, "gru3_input_bias", "gru3_input_subias", "gru3_input_weights_int8","gru3_input_weights_float", "gru3_input_weights_idx", NULL, "gru3_input_scale", 384, 1152)) return 1;
    if (linear_init(&model->gru3_recurrent, arrays, "gru3_recurrent_bias", "gru3_recurrent_subias", "gru3_recurrent_weights_int8","gru3_recurrent_weights_float", "gru3_recurrent_weights_idx", "gru3_recurrent_weights_diag", "gru3_recurrent_scale", 384, 1152)) return 1;
    if (linear_init(&model->dense_out, arrays, "dense_out_bias", NULL, NULL,"dense_out_weights_float", NULL, NULL, NULL, 1536, 32)) return 1;
    if (linear_init(&model->vad_dense, arrays, "vad_dense_bias", NULL, NULL,"vad_dense_weights_float", NULL, NULL, NULL, 1536, 1)) return 1;
    return 0;
}
#endif /* DUMP_BINARY_WEIGHTS */
