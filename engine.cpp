// Task 2 + Task 3: Headless continuous-2D wolf-rabbit engine with native
// action masking, bound to Python via pybind11.
//
// Memory model (the whole point): every per-step array is a fixed-size, flat,
// contiguous buffer allocated ONCE at construction. The step loop does zero
// heap allocation -> stable RSS, no leaks, safe for PufferLib's zero-copy
// shared-memory vectorization.
//
// Layout mirrors wolf_rabbit.py exactly so the two are interchangeable:
//   obs[N, OBS_DIM]  OBS_DIM = 2 + 3*MAX_RABBITS
//   action[N, 2]     head0 = direction(8), head1 = move/stay(2)
//   mask[N, 8]       uint8, 1 = direction allowed (would stay in bounds)
//
#include <pybind11/pybind11.h>
#include <pybind11/numpy.h>
#include <cmath>
#include <cstdint>
#include <random>

namespace py = pybind11;

static constexpr int MAX_RABBITS = 8;
static constexpr int OBS_DIM = 2 + 3 * MAX_RABBITS;
static constexpr int N_DIRS = 8;

// 8 compass unit vectors (same order as _DIRS in wolf_rabbit.py)
static const float DIRX[8] = { 1.f, 0.70710678f, 0.f, -0.70710678f,
                              -1.f, -0.70710678f, 0.f, 0.70710678f };
static const float DIRY[8] = { 0.f, 0.70710678f, 1.f, 0.70710678f,
                               0.f, -0.70710678f, -1.f, -0.70710678f };

class Engine {
public:
    Engine(int num_agents, float map_half, int n_rabbits, float wolf_speed,
           float eat_radius, int max_steps, uint64_t seed)
        : N(num_agents), H(map_half), n_rabbits(n_rabbits),
          wolf_speed(wolf_speed), eat_radius(eat_radius), max_steps(max_steps),
          rng(seed),
          // allocate all flat buffers exactly once
          obs_({(size_t)N, (size_t)OBS_DIM}),
          rew_({(size_t)N}),
          term_({(size_t)N}),
          trunc_({(size_t)N}),
          mask_({(size_t)N, (size_t)N_DIRS}),
          wolf_x(N), wolf_y(N),
          rab_x((size_t)N * MAX_RABBITS), rab_y((size_t)N * MAX_RABBITS),
          active((size_t)N * MAX_RABBITS, 0),
          steps(N, 0), eaten(N, 0), bhits(N, 0),
          last_eaten(N, 0), last_bhits(N, 0), prev_dist(N, 0.f) {}

    void reset(uint64_t seed) {
        rng.seed(seed);
        for (int i = 0; i < N; ++i) {
            wolf_x[i] = uni(-H, H);
            wolf_y[i] = uni(-H, H);
            for (int j = 0; j < MAX_RABBITS; ++j) {
                int k = i * MAX_RABBITS + j;
                rab_x[k] = uni(-H, H);
                rab_y[k] = uni(-H, H);
                active[k] = (j < n_rabbits) ? 1 : 0;
            }
            steps[i] = 0; eaten[i] = 0; bhits[i] = 0;
            prev_dist[i] = nearest_dist(i);
        }
        compute_obs();
        compute_mask();
    }

    // step takes a flat int32 [N,2] action array (read-only)
    void step(py::array_t<int32_t, py::array::c_style | py::array::forcecast> actions) {
        const int32_t* a = actions.data();
        float* rew = rew_.mutable_data();
        uint8_t* term = term_.mutable_data();
        uint8_t* trunc = trunc_.mutable_data();

        for (int i = 0; i < N; ++i) {
            int dir = a[2 * i + 0];
            int move = a[2 * i + 1];
            float nx = wolf_x[i] + DIRX[dir] * move * wolf_speed;
            float ny = wolf_y[i] + DIRY[dir] * move * wolf_speed;
            // boundary: clamp + count would-be violations
            float cx = nx < -H ? -H : (nx > H ? H : nx);
            float cy = ny < -H ? -H : (ny > H ? H : ny);
            if (cx != nx || cy != ny) bhits[i]++;
            wolf_x[i] = cx; wolf_y[i] = cy;

            rew[i] = 0.f;
            steps[i]++;

            // nearest-rabbit distance shaping + eating
            float best = 1e30f; int best_j = -1;
            for (int j = 0; j < MAX_RABBITS; ++j) {
                int k = i * MAX_RABBITS + j;
                if (!active[k]) continue;
                float dx = rab_x[k] - cx, dy = rab_y[k] - cy;
                float d = std::sqrt(dx * dx + dy * dy);
                if (d < best) { best = d; best_j = j; }
                if (d <= eat_radius) {
                    rew[i] += 1.f; eaten[i]++;
                    rab_x[k] = uni(-H, H); rab_y[k] = uni(-H, H);  // respawn
                }
            }
            if (best_j >= 0 && prev_dist[i] < 1e29f)
                rew[i] += (prev_dist[i] - best);

            // truncate on time limit -> auto reset this game
            term[i] = 0;
            trunc[i] = 0;
            if (steps[i] >= max_steps) {
                trunc[i] = 1;
                last_eaten[i] = eaten[i];   // snapshot before reset
                last_bhits[i] = bhits[i];
                wolf_x[i] = uni(-H, H); wolf_y[i] = uni(-H, H);
                for (int j = 0; j < MAX_RABBITS; ++j) {
                    int k = i * MAX_RABBITS + j;
                    rab_x[k] = uni(-H, H); rab_y[k] = uni(-H, H);
                    active[k] = (j < n_rabbits) ? 1 : 0;
                }
                steps[i] = 0; eaten[i] = 0; bhits[i] = 0;
            }
            prev_dist[i] = nearest_dist(i);
        }
        compute_obs();
        compute_mask();
    }

    void set_map_half(float h) { H = h; }   // curriculum: resize arena in place

    // zero-copy views into the engine's flat buffers
    py::array_t<float> observations() { return obs_; }
    py::array_t<float> rewards() { return rew_; }
    py::array_t<uint8_t> terminals() { return term_; }
    py::array_t<uint8_t> truncations() { return trunc_; }
    py::array_t<uint8_t> masks() { return mask_; }

    py::array_t<int32_t> eaten_arr() {
        return py::array_t<int32_t>({(size_t)N}, eaten.data());
    }
    py::array_t<int32_t> bhits_arr() {
        return py::array_t<int32_t>({(size_t)N}, bhits.data());
    }
    py::array_t<int32_t> last_eaten_arr() {
        return py::array_t<int32_t>({(size_t)N}, last_eaten.data());
    }
    py::array_t<int32_t> last_bhits_arr() {
        return py::array_t<int32_t>({(size_t)N}, last_bhits.data());
    }

    int num_agents() const { return N; }
    int obs_dim() const { return OBS_DIM; }

private:
    float uni(float lo, float hi) {
        return lo + (hi - lo) * dist01(rng);
    }
    float nearest_dist(int i) {
        float best = 1e30f;
        for (int j = 0; j < MAX_RABBITS; ++j) {
            int k = i * MAX_RABBITS + j;
            if (!active[k]) continue;
            float dx = rab_x[k] - wolf_x[i], dy = rab_y[k] - wolf_y[i];
            float d = std::sqrt(dx * dx + dy * dy);
            if (d < best) best = d;
        }
        return best;
    }
    void compute_obs() {
        float* o = obs_.mutable_data();
        const float inv_h = 1.f / H;
        const float inv_2h = 1.f / (2.f * H);
        for (int i = 0; i < N; ++i) {
            float* row = o + (size_t)i * OBS_DIM;
            row[0] = clampf(wolf_x[i] * inv_h);
            row[1] = clampf(wolf_y[i] * inv_h);
            for (int j = 0; j < MAX_RABBITS; ++j) {
                int k = i * MAX_RABBITS + j;
                float* e = row + 2 + 3 * j;
                float act = (float)active[k];
                e[0] = act;
                e[1] = clampf((rab_x[k] - wolf_x[i]) * inv_2h) * act;
                e[2] = clampf((rab_y[k] - wolf_y[i]) * inv_2h) * act;
            }
        }
    }
    // Task 3: look-ahead boundary mask. A direction is allowed (1) if moving
    // one step that way keeps the wolf strictly inside the arena.
    void compute_mask() {
        uint8_t* m = mask_.mutable_data();
        for (int i = 0; i < N; ++i) {
            uint8_t* row = m + (size_t)i * N_DIRS;
            for (int d = 0; d < N_DIRS; ++d) {
                float nx = wolf_x[i] + DIRX[d] * wolf_speed;
                float ny = wolf_y[i] + DIRY[d] * wolf_speed;
                row[d] = (nx >= -H && nx <= H && ny >= -H && ny <= H) ? 1 : 0;
            }
        }
    }
    static inline float clampf(float v) {
        return v < -1.f ? -1.f : (v > 1.f ? 1.f : v);
    }

    int N, n_rabbits, max_steps;
    float H, wolf_speed, eat_radius;
    std::mt19937_64 rng;
    std::uniform_real_distribution<float> dist01{0.f, 1.f};

    py::array_t<float> obs_, rew_;
    py::array_t<uint8_t> term_, trunc_, mask_;
    std::vector<float> wolf_x, wolf_y, rab_x, rab_y;
    std::vector<uint8_t> active;
    std::vector<int32_t> steps, eaten, bhits, last_eaten, last_bhits;
    std::vector<float> prev_dist;
};

PYBIND11_MODULE(wolf_engine, m) {
    m.attr("MAX_RABBITS") = MAX_RABBITS;
    m.attr("OBS_DIM") = OBS_DIM;
    py::class_<Engine>(m, "Engine")
        .def(py::init<int, float, int, float, float, int, uint64_t>(),
             py::arg("num_agents"), py::arg("map_half") = 1.5f,
             py::arg("n_rabbits") = 1, py::arg("wolf_speed") = 0.15f,
             py::arg("eat_radius") = 0.12f, py::arg("max_steps") = 256,
             py::arg("seed") = 0)
        .def("reset", &Engine::reset, py::arg("seed") = 0)
        .def("step", &Engine::step)
        .def("set_map_half", &Engine::set_map_half)
        .def("observations", &Engine::observations)
        .def("rewards", &Engine::rewards)
        .def("terminals", &Engine::terminals)
        .def("truncations", &Engine::truncations)
        .def("masks", &Engine::masks)
        .def("eaten", &Engine::eaten_arr)
        .def("boundary_hits", &Engine::bhits_arr)
        .def("last_eaten", &Engine::last_eaten_arr)
        .def("last_boundary_hits", &Engine::last_bhits_arr)
        .def("num_agents", &Engine::num_agents)
        .def("obs_dim", &Engine::obs_dim);
}
