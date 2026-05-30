// Task 1: Multi-agent Lotka-Volterra ecosystem engine (Foxes / Rabbits / Grass)
// with a zero-allocation fixed entity pool and an O(1) spatial hash grid.
//
// THE MEMORY CONTRACT (the whole point of Task 1):
//   * Every entity lives in a fixed-size, contiguous, struct-of-arrays pool of
//     MAX_TOTAL_ENTITIES slots allocated ONCE in the constructor.
//   * Birth = pop a slot index off a preallocated free-list stack.
//     Death  = push that index back. No std::vector resize, no `new`, nothing
//     heap-touching happens inside step(). RSS stays flat under churn.
//   * Neighbour proximity uses a counting-sort spatial grid rebuilt each step
//     in O(N) into preallocated buffers -> O(1) amortised neighbour lookups,
//     no N^2 blowup at hundreds of entities.
//
// Entity types: 0 = EMPTY, 1 = GRASS, 2 = RABBIT, 3 = FOX.
//
// The world is [0, world] x [0, world]. cell_size defaults to the vision/eat
// radius so a 3x3 cell sweep covers every possible interaction neighbour.
//
#include <pybind11/pybind11.h>
#include <pybind11/numpy.h>
#include <cmath>
#include <cstdint>
#include <random>
#include <vector>

namespace py = pybind11;

static constexpr int MAX_TOTAL_ENTITIES = 1024;
static constexpr int EMPTY  = 0;
static constexpr int GRASS  = 1;
static constexpr int RABBIT = 2;
static constexpr int FOX    = 3;
static constexpr int N_DIRS = 8;

// per-agent observation schema -- MUST match eco_policy.py
static constexpr int SELF_DIM = 4;     // [x, y, energy_norm, is_fox]
static constexpr int ENT_DIM  = 6;     // [active, rel_dx, rel_dy, is_rab, is_fox, is_grass]
static constexpr int MAX_VIS  = 16;
static constexpr int AOBS = SELF_DIM + MAX_VIS * ENT_DIM;   // 100

static const float DIRX[8] = { 1.f, 0.70710678f, 0.f, -0.70710678f,
                              -1.f, -0.70710678f, 0.f, 0.70710678f };
static const float DIRY[8] = { 0.f, 0.70710678f, 1.f, 0.70710678f,
                               0.f, -0.70710678f, -1.f, -0.70710678f };

struct Birth { int8_t type; float x, y, e; };

class EcoEngine {
public:
    EcoEngine(float world, float cell_size, float vision, float eat_radius,
              float move_speed,
              float rabbit_metab, float fox_metab, float rabbit_move_cost,
              float grass_energy, float rabbit_energy_to_fox,
              float repro_threshold, float init_energy,
              int n_rabbits0, int n_foxes0, int n_grass0,
              int grass_max, float grass_spawn_rate,
              float max_age, int refuge_rabbits, int refuge_foxes,
              bool use_grid, uint64_t seed)
        : world(world), cell(cell_size), vision(vision), eat_r(eat_radius),
          speed(move_speed),
          rabbit_metab(rabbit_metab), fox_metab(fox_metab),
          rabbit_move_cost(rabbit_move_cost),
          grass_energy(grass_energy), rabbit_energy_to_fox(rabbit_energy_to_fox),
          repro_threshold(repro_threshold), init_energy(init_energy),
          n_rabbits0(n_rabbits0), n_foxes0(n_foxes0), n_grass0(n_grass0),
          grass_max(grass_max), grass_spawn_rate(grass_spawn_rate),
          max_age(max_age), refuge_rabbits(refuge_rabbits),
          refuge_foxes(refuge_foxes), use_grid(use_grid), rng(seed),
          // fixed pools, allocated exactly once
          etype(MAX_TOTAL_ENTITIES, EMPTY),
          ex(MAX_TOTAL_ENTITIES, 0.f), ey(MAX_TOTAL_ENTITIES, 0.f),
          energy(MAX_TOTAL_ENTITIES, 0.f), age(MAX_TOTAL_ENTITIES, 0.f),
          dir(MAX_TOTAL_ENTITIES, 0),
          free_stack(MAX_TOTAL_ENTITIES, 0),
          cell_of(MAX_TOTAL_ENTITIES, 0),
          sorted_idx(MAX_TOTAL_ENTITIES, 0),
          alist(MAX_TOTAL_ENTITIES, 0), apos(MAX_TOTAL_ENTITIES, -1),
          dead(MAX_TOTAL_ENTITIES, 0),
          kill_q(MAX_TOTAL_ENTITIES, 0), birth_q(MAX_TOTAL_ENTITIES),
          obs_buf({(size_t)MAX_TOTAL_ENTITIES, (size_t)AOBS}),
          slot_buf({(size_t)MAX_TOTAL_ENTITIES}),
          type_buf({(size_t)MAX_TOTAL_ENTITIES})
    {
        rstate = seed ? seed : 0x9e3779b97f4a7c15ULL;
        ncx = std::max(1, (int)std::floor(world / cell));
        ncy = ncx;
        ncells = ncx * ncy;
        cell_count.assign(ncells + 1, 0);
        cell_cursor.assign(ncells + 1, 0);
        reset(seed);
    }

    void reset(uint64_t seed) {
        rng.seed(seed);
        rstate = seed ? seed : 0x9e3779b97f4a7c15ULL;
        // wipe pool, rebuild free-list (descending so we hand out 0,1,2,... first)
        for (int i = 0; i < MAX_TOTAL_ENTITIES; ++i) { etype[i] = EMPTY; apos[i] = -1; }
        free_top = 0;
        for (int i = MAX_TOTAL_ENTITIES - 1; i >= 0; --i)
            free_stack[free_top++] = i;
        n_active = 0;
        n_rabbits = n_foxes = n_grass = 0;
        grass_accum = 0.f;
        for (int i = 0; i < n_grass0;   ++i) spawn(GRASS,  rx(), rx(), grass_energy);
        for (int i = 0; i < n_rabbits0; ++i) spawn(RABBIT, rx(), rx(), init_energy);
        for (int i = 0; i < n_foxes0;   ++i) spawn(FOX,    rx(), rx(), init_energy);
    }

    // One ecological tick. `actions` is an optional [MAX_TOTAL_ENTITIES] int8
    // array of desired directions (0..7) per slot; -1 (or absent) => random walk
    // for that slot. Returns nothing; inspect via the accessor arrays.
    void step(py::array_t<int8_t, py::array::c_style | py::array::forcecast> actions,
              bool use_actions) {
        const int8_t* a = use_actions ? actions.data() : nullptr;
        // snapshot: only entities alive at the start of the tick act this frame.
        const int cnt = n_active;

        // --- movement + metabolism (mutates only pos/energy/age: safe) ---
        for (int s = 0; s < cnt; ++s) {
            int i = alist[s];
            int t = etype[i];
            if (t == GRASS) continue;
            int d;
            if (a && a[i] >= 0) d = a[i] & 7;
            else d = dir[i] = (int)(xr() & 7);
            float nx = ex[i] + DIRX[d] * speed;
            float ny = ey[i] + DIRY[d] * speed;
            // reflective boundaries keep everyone inside the arena
            if (nx < 0.f) nx = -nx; else if (nx > world) nx = 2.f*world - nx;
            if (ny < 0.f) ny = -ny; else if (ny > world) ny = 2.f*world - ny;
            ex[i] = nx; ey[i] = ny;
            age[i] += 1.f;
            if (t == RABBIT) energy[i] -= (rabbit_metab + rabbit_move_cost);
            else             energy[i] -= fox_metab;       // fox fixed cost
        }

        if (use_grid) build_grid();

        // --- interactions: rabbits eat grass, foxes eat rabbits ---
        // Deferred: mark prey dead, queue kills (a dead prey can't be eaten
        // twice and can't act later this tick).
        int nk = 0;
        for (int s = 0; s < cnt; ++s) {
            int i = alist[s];
            if (dead[i]) continue;
            int t = etype[i];
            if (t == RABBIT) {
                int prey = nearest_prey(i, GRASS);
                if (prey >= 0) { energy[i] += grass_energy; dead[prey] = 1; kill_q[nk++] = prey; }
            } else if (t == FOX) {
                int prey = nearest_prey(i, RABBIT);
                if (prey >= 0) { energy[i] += rabbit_energy_to_fox; dead[prey] = 1; kill_q[nk++] = prey; }
            }
        }

        // --- reproduction (binary fission) + starvation/age death ---
        int nb = 0;
        for (int s = 0; s < cnt; ++s) {
            int i = alist[s];
            if (dead[i] || etype[i] == GRASS) continue;
            int t = etype[i];
            if (energy[i] <= 0.f || (max_age > 0.f && age[i] >= max_age)) {
                dead[i] = 1; kill_q[nk++] = i;
                continue;
            }
            if (energy[i] >= repro_threshold) {
                float child_e = energy[i] * 0.5f;
                energy[i] = child_e;
                age[i] = 0.f;
                Birth b; b.type = (int8_t)t;
                b.x = clampw(ex[i] + (xf() - 0.5f) * speed);
                b.y = clampw(ey[i] + (xf() - 0.5f) * speed);
                b.e = child_e;
                birth_q[nb++] = b;
            }
        }

        // apply deferred kills then births (births may reuse just-freed slots)
        for (int k = 0; k < nk; ++k) { dead[kill_q[k]] = 0; kill(kill_q[k]); }
        for (int b = 0; b < nb; ++b)
            spawn(birth_q[b].type, birth_q[b].x, birth_q[b].y, birth_q[b].e);

        // --- grass regrowth (passive energy nodes) ---
        grass_accum += grass_spawn_rate;
        while (grass_accum >= 1.f && n_grass < grass_max && free_top > 0) {
            spawn(GRASS, rx(), rx(), grass_energy);
            grass_accum -= 1.f;
        }

        // --- refuge / source populations (mechanical anti-extinction guardrail) ---
        // A protected breeding refuge slowly re-seeds a species that has crashed,
        // so the system never hits an unrecoverable 0-population dead state and
        // oscillations can resume. Repopulate at most one of each per tick.
        while (n_rabbits < refuge_rabbits && free_top > 0)
            spawn(RABBIT, rx(), rx(), init_energy);
        while (n_foxes < refuge_foxes && free_top > 0)
            spawn(FOX, rx(), rx(), init_energy);
        steps++;
    }

    // Build per-agent observations (rabbits + foxes) in the eco_policy layout.
    // Fills obs_buf[n_agents, AOBS], slot_buf[n_agents], type_buf[n_agents].
    // Returns n_agents. Python slices by type and routes to the two policies.
    int build_agent_obs() {
        build_grid();
        float* o = obs_buf.mutable_data();
        int32_t* sl = (int32_t*)slot_buf.mutable_data();
        int8_t*  ty = (int8_t*)type_buf.mutable_data();
        const float inv_v = 1.f / vision;
        const float inv_e = 1.f / repro_threshold;
        const int R = (int)std::ceil(vision / cell);
        const float vis2 = vision * vision;
        int na = 0;
        for (int s = 0; s < n_active; ++s) {
            int i = alist[s];
            int t = etype[i];
            if (t != RABBIT && t != FOX) continue;
            float px = ex[i], py_ = ey[i];
            float* row = o + (size_t)na * AOBS;
            row[0] = px / world * 2.f - 1.f;
            row[1] = py_ / world * 2.f - 1.f;
            float en = energy[i] * inv_e; row[2] = en > 1.f ? 1.f : en;
            row[3] = (t == FOX) ? 1.f : 0.f;
            // gather nearest MAX_VIS neighbours within vision via the grid
            float nd[MAX_VIS]; int nj[MAX_VIS]; int nc = 0;
            int cx = (int)(px / cell), cy = (int)(py_ / cell);
            if (cx < 0) cx = 0; else if (cx >= ncx) cx = ncx - 1;
            if (cy < 0) cy = 0; else if (cy >= ncy) cy = ncy - 1;
            for (int dy = -R; dy <= R; ++dy) {
                int yy = cy + dy; if (yy < 0 || yy >= ncy) continue;
                for (int dx = -R; dx <= R; ++dx) {
                    int xx = cx + dx; if (xx < 0 || xx >= ncx) continue;
                    int c = yy * ncx + xx;
                    for (int q = cell_count[c]; q < cell_count[c + 1]; ++q) {
                        int j = sorted_idx[q];
                        if (j == i) continue;
                        float ddx = ex[j] - px, ddy = ey[j] - py_;
                        float d2 = ddx*ddx + ddy*ddy;
                        if (d2 > vis2) continue;
                        if (nc < MAX_VIS) { nd[nc] = d2; nj[nc] = j; nc++; }
                        else {  // replace current farthest if this is nearer
                            int mx = 0; for (int m = 1; m < MAX_VIS; ++m)
                                if (nd[m] > nd[mx]) mx = m;
                            if (d2 < nd[mx]) { nd[mx] = d2; nj[mx] = j; }
                        }
                    }
                }
            }
            // write entity rows (order irrelevant: trunk is permutation-invariant)
            for (int k = 0; k < MAX_VIS; ++k) {
                float* e = row + SELF_DIM + k * ENT_DIM;
                if (k < nc) {
                    int j = nj[k]; int jt = etype[j];
                    e[0] = 1.f;
                    e[1] = (ex[j] - px) * inv_v;
                    e[2] = (ey[j] - py_) * inv_v;
                    e[3] = (jt == RABBIT) ? 1.f : 0.f;
                    e[4] = (jt == FOX) ? 1.f : 0.f;
                    e[5] = (jt == GRASS) ? 1.f : 0.f;
                } else {
                    for (int m = 0; m < ENT_DIM; ++m) e[m] = 0.f;
                }
            }
            sl[na] = i; ty[na] = (int8_t)t; na++;
        }
        n_agents = na;
        return na;
    }
    // views valid until the next build_agent_obs / step
    py::array_t<float>   agent_obs()   { return py::array_t<float>({(size_t)n_agents, (size_t)AOBS}, obs_buf.data()); }
    py::array_t<int32_t> agent_slots() { return py::array_t<int32_t>({(size_t)n_agents}, (int32_t*)slot_buf.data()); }
    py::array_t<int8_t>  agent_types() { return py::array_t<int8_t>({(size_t)n_agents}, (int8_t*)type_buf.data()); }

    void set_world(float w) { world = w; }

    // ---- accessors (zero-copy snapshots are not safe across step, so copy) ----
    py::array_t<int8_t> types() {
        return py::array_t<int8_t>({(size_t)MAX_TOTAL_ENTITIES}, etype.data());
    }
    py::array_t<float> xs() {
        return py::array_t<float>({(size_t)MAX_TOTAL_ENTITIES}, ex.data());
    }
    py::array_t<float> ys() {
        return py::array_t<float>({(size_t)MAX_TOTAL_ENTITIES}, ey.data());
    }
    py::array_t<float> energies() {
        return py::array_t<float>({(size_t)MAX_TOTAL_ENTITIES}, energy.data());
    }

    int count_rabbits() const { return n_rabbits; }
    int count_foxes()   const { return n_foxes; }
    int count_grass()   const { return n_grass; }
    int active_count()  const { return n_rabbits + n_foxes + n_grass; }
    int capacity()      const { return MAX_TOTAL_ENTITIES; }
    int free_slots()    const { return free_top; }
    long step_count()   const { return steps; }

private:
    // fast xorshift RNG for the hot path (mt19937 is too slow per-entity)
    inline uint64_t xr() {
        uint64_t x = rstate;
        x ^= x << 13; x ^= x >> 7; x ^= x << 17;
        return rstate = x;
    }
    inline float xf() { return (xr() >> 40) * (1.0f / 16777216.0f); }  // [0,1)
    float uni() { return xf(); }
    float rx()  { return xf() * world; }
    float clampw(float v) { return v < 0.f ? 0.f : (v > world ? world : v); }

    int spawn(int t, float x, float y, float e) {
        if (free_top == 0) return -1;            // graceful failure at cap
        int i = free_stack[--free_top];
        etype[i] = t; ex[i] = x; ey[i] = y; energy[i] = e; age[i] = 0.f;
        dir[i] = (int)(xr() & 7);
        apos[i] = n_active; alist[n_active++] = i;   // append to dense list
        if (t == RABBIT) n_rabbits++;
        else if (t == FOX) n_foxes++;
        else if (t == GRASS) n_grass++;
        return i;
    }
    void kill(int i) {
        int t = etype[i];
        if (t == EMPTY) return;
        if (t == RABBIT) n_rabbits--;
        else if (t == FOX) n_foxes--;
        else if (t == GRASS) n_grass--;
        etype[i] = EMPTY;
        free_stack[free_top++] = i;
        // swap-remove from dense list
        int p = apos[i]; int last = alist[--n_active];
        alist[p] = last; apos[last] = p; apos[i] = -1;
    }

    inline int cell_index(float x, float y) const {
        int cx = (int)(x / cell); int cy = (int)(y / cell);
        if (cx < 0) cx = 0; else if (cx >= ncx) cx = ncx - 1;
        if (cy < 0) cy = 0; else if (cy >= ncy) cy = ncy - 1;
        return cy * ncx + cx;
    }

    // counting-sort all active entities into per-cell contiguous runs
    void build_grid() {
        for (int c = 0; c <= ncells; ++c) cell_count[c] = 0;
        for (int s = 0; s < n_active; ++s) {
            int i = alist[s];
            int c = cell_index(ex[i], ey[i]);
            cell_of[i] = c;
            cell_count[c + 1]++;
        }
        for (int c = 0; c < ncells; ++c) cell_count[c + 1] += cell_count[c];
        for (int c = 0; c <= ncells; ++c) cell_cursor[c] = cell_count[c];
        for (int s = 0; s < n_active; ++s) {
            int i = alist[s];
            sorted_idx[cell_cursor[cell_of[i]]++] = i;
        }
    }

    // nearest active entity of `prey_type` within eat radius of consumer i
    int nearest_prey(int i, int prey_type) {
        if (!use_grid) {        // O(N) brute-force baseline -> O(N^2) per tick
            float px = ex[i], py_ = ey[i];
            float best = eat_r * eat_r; int best_j = -1;
            for (int s = 0; s < n_active; ++s) {
                int j = alist[s];
                if (etype[j] != prey_type) continue;
                float ddx = ex[j] - px, ddy = ey[j] - py_;
                float d2 = ddx*ddx + ddy*ddy;
                if (d2 < best) { best = d2; best_j = j; }
            }
            return best_j;
        }
        float px = ex[i], py_ = ey[i];
        int cx = (int)(px / cell); int cy = (int)(py_ / cell);
        if (cx < 0) cx = 0; else if (cx >= ncx) cx = ncx - 1;
        if (cy < 0) cy = 0; else if (cy >= ncy) cy = ncy - 1;
        float best = eat_r * eat_r; int best_j = -1;
        for (int dy = -1; dy <= 1; ++dy) {
            int ny = cy + dy; if (ny < 0 || ny >= ncy) continue;
            for (int dx = -1; dx <= 1; ++dx) {
                int nx = cx + dx; if (nx < 0 || nx >= ncx) continue;
                int c = ny * ncx + nx;
                for (int s = cell_count[c]; s < cell_count[c + 1]; ++s) {
                    int j = sorted_idx[s];
                    if (etype[j] != prey_type) continue;
                    float ddx = ex[j] - px, ddy = ey[j] - py_;
                    float d2 = ddx*ddx + ddy*ddy;
                    if (d2 < best) { best = d2; best_j = j; }
                }
            }
        }
        return best_j;
    }

    float world, cell, vision, eat_r, speed;
    float rabbit_metab, fox_metab, rabbit_move_cost;
    float grass_energy, rabbit_energy_to_fox, repro_threshold, init_energy;
    int n_rabbits0, n_foxes0, n_grass0, grass_max;
    float grass_spawn_rate, max_age;
    int refuge_rabbits, refuge_foxes;
    std::mt19937_64 rng;
    std::uniform_real_distribution<float> dist01{0.f, 1.f};

    int ncx, ncy, ncells;
    int n_rabbits = 0, n_foxes = 0, n_grass = 0;
    int n_active = 0;
    int free_top = 0;
    bool use_grid = true;
    long steps = 0;
    float grass_accum = 0.f;
    uint64_t rstate = 0x9e3779b97f4a7c15ULL;

    std::vector<int8_t> etype;
    std::vector<float> ex, ey, energy, age;
    std::vector<int8_t> dir;
    std::vector<int32_t> free_stack, cell_of, sorted_idx;
    std::vector<int32_t> cell_count, cell_cursor;
    std::vector<int32_t> alist, apos;
    std::vector<uint8_t> dead;
    std::vector<int32_t> kill_q;
    std::vector<Birth> birth_q;
    int n_agents = 0;
    py::array_t<float> obs_buf;
    py::array_t<int32_t> slot_buf;
    py::array_t<int8_t> type_buf;
};

PYBIND11_MODULE(eco_engine, m) {
    m.attr("MAX_TOTAL_ENTITIES") = MAX_TOTAL_ENTITIES;
    m.attr("EMPTY")  = EMPTY;
    m.attr("GRASS")  = GRASS;
    m.attr("RABBIT") = RABBIT;
    m.attr("FOX")    = FOX;
    m.attr("AOBS")   = AOBS;
    m.attr("MAX_VIS") = MAX_VIS;
    py::class_<EcoEngine>(m, "EcoEngine")
        .def(py::init<float, float, float, float, float, float, float, float,
                      float, float, float, float, int, int, int, int, float,
                      float, int, int, bool, uint64_t>(),
             py::arg("world") = 100.f, py::arg("cell_size") = 4.f,
             py::arg("vision") = 12.f, py::arg("eat_radius") = 1.5f,
             py::arg("move_speed") = 1.0f,
             py::arg("rabbit_metab") = 0.2f, py::arg("fox_metab") = 0.5f,
             py::arg("rabbit_move_cost") = 0.05f,
             py::arg("grass_energy") = 4.0f, py::arg("rabbit_energy_to_fox") = 12.0f,
             py::arg("repro_threshold") = 20.0f, py::arg("init_energy") = 10.0f,
             py::arg("n_rabbits0") = 100, py::arg("n_foxes0") = 20,
             py::arg("n_grass0") = 200, py::arg("grass_max") = 400,
             py::arg("grass_spawn_rate") = 4.0f, py::arg("max_age") = 0.f,
             py::arg("refuge_rabbits") = 0, py::arg("refuge_foxes") = 0,
             py::arg("use_grid") = true, py::arg("seed") = 0)
        .def("reset", &EcoEngine::reset, py::arg("seed") = 0)
        .def("step", &EcoEngine::step, py::arg("actions"), py::arg("use_actions") = false)
        .def("set_world", &EcoEngine::set_world)
        .def("build_agent_obs", &EcoEngine::build_agent_obs)
        .def("agent_obs", &EcoEngine::agent_obs)
        .def("agent_slots", &EcoEngine::agent_slots)
        .def("agent_types", &EcoEngine::agent_types)
        .def("types", &EcoEngine::types)
        .def("xs", &EcoEngine::xs)
        .def("ys", &EcoEngine::ys)
        .def("energies", &EcoEngine::energies)
        .def("count_rabbits", &EcoEngine::count_rabbits)
        .def("count_foxes", &EcoEngine::count_foxes)
        .def("count_grass", &EcoEngine::count_grass)
        .def("active_count", &EcoEngine::active_count)
        .def("capacity", &EcoEngine::capacity)
        .def("free_slots", &EcoEngine::free_slots)
        .def("step_count", &EcoEngine::step_count);
}
