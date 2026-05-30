pufferlib reinforcenemt learning library



we want to work towards a wow-arena style game



its important to be able to train entity models. for example start with modelling rabbits and foxes reproduction cycle



we will need a C++ headless game binary for this, which can be used a an environment or later backend for game



for example we want to have wolf and rabbit entities. and wofl muts eat rabbit. like a very oversimplified snake game but in 2d



so the input to the wolf should be like a minimap style top down. and the output. we need some inspiration there is some moba heroe of kings chinese RL paper. the emphasis is on not learning pixels but some more simplified game state



but then what is the outputs. a vector and speed, or scores for a position



later we'll need to account for debuffs, projectiles, enemies/friendles, barriers or walls. we would need some encoder heads or somehting



what is the mvp to have wolves hunt rabbits and be able to support what we want lter 



his updated, end-to-end engineering roadmap integrates PufferLib, your headless C++ game code, action masking, and curriculum learning.Because PufferLib relies heavily on flat, contiguous buffers mapped straight into Python/PyTorch via shared memory, the core philosophy here is zero-allocation during the step loop.The Core Data Pipeline+-----------------------------------------------------------------------------------+
|                              PYTHON (PufferLib + PPO)                             |
|  - Reads Flat Contiguous Shared Buffers                                           |
|  - Unpacks Observations into [Self State] and [Entity Arrays] using PyTorch       |
|  - Applies Action Mask to Logits (-inf bias) before Action Sampling               |
+-----------------------------------------------------------------------------------+
                                         │  (Pybind11 Direct Pointer Pass)
                                         ▼
+-----------------------------------------------------------------------------------+
|                             C++ HEADLESS ENGINE CORE                              |
|  - Memory: Fixed-size flat arrays (No dynamic std::vector resizing inside step)    |
|  - Physics/Logic: Updates continuous positions within a dynamic bounding box      |
|  - Masking: Checks boundary violations -> populates boolean mask array            |
+-----------------------------------------------------------------------------------+
Production Implementation RoadmapTask 1: Flat Python Prototype with PufferLib BaselinesDescription: Before touching C++, construct a pure-Python mock environment matching your exact observation layout (using relative positions) and multi-discrete action space. Hook this prototype up to PufferLib’s packaged CleanRL PPO baseline script to ensure your observation dimensions, MultiDiscrete action spaces, and internal reward definitions map cleanly into PufferLib's emulation layer.Acceptance Criteria: * Python test script initiates a training loop using pufferlib.vectorization.Multiprocessing or Serial.Model registers non-nan losses across 5,000 steps.Base Metric & Value: Baseline Sample Throughput $\rightarrow$ $0$ steps/sec (uninitialized).Expected Post-Task Value: $\ge 2,000$ steps/sec (Pure Python loop bottleneck).Most Critical Metric to Safeguard: Shape Mismatch Failures during Vectorization.Guardrail against degradation: The environment's observation and action space specifications must be hardcoded constants. If arrays dynamically resize based on live entity counts, PufferLib's zero-copy shared memory allocator will instantly throw a segmentation fault or memory alignment panic.Task 2: Headless C++ Simulation Core with Pybind11 BindingDescription: Write the headless continuous 2D simulator engine in C++. Map entities to simple, fixed-size flat arrays (e.g., float wolf[4], float rabbits[MAX_RABBITS * 4]). Implement relative position calculation, basic intersection code (wolf eating rabbit), variable map dimension logic, and a lightweight serialize_state() function converting current positions to a packed binary array or plain JSON string. Bind the execution hook directly to Python via Pybind11.Acceptance Criteria: * Module compiles into a native .so/.pyd binary.Stepping the engine 10,000 times from a Python test script yields correct tracking math and structural stability.Base Metric & Value: Simulation Speed $\rightarrow$ $\sim 2,000$ steps/sec (from Task 1 Python baseline).Expected Post-Task Value: $\ge 150,000$ steps/sec per single core.Most Critical Metric to Safeguard: Memory Accumulation Rate.Guardrail against degradation: Track Resident Set Size (RSS) memory across 2,000,000 execution iterations. Heap memory usage variance must measure exactly 0%. Any upward drift reveals a string allocation or object instantiation memory leak within your loop that will quickly crash your parallelized RL workers.Task 3: C++ Native Action Masking ImplementationDescription: Integrate boundary constraint enforcement directly inside the C++ step loop. For each frame, look ahead at the 8 directional movement choices. If a choice would move the wolf outside the dynamic map boundary, mark that option index as $0$ in a flat uint8_t mask_buffer passed back alongside the observation array. Wire this buffer to PufferLib's internal masking mechanics.Acceptance Criteria: * PufferLib/PPO policy reads the mask natively, resulting in the wolf taking zero invalid actions.Base Metric & Value: Boundary Violations per Episode $\rightarrow$ Baseline: $\ge 25$ touches/failures per episode (Random Agent without mask).Expected Post-Task Value: 0 boundary violations across all training episodes.Most Critical Metric to Safeguard: Vector Throughput Overhead.Guardrail against degradation: Mask generation code must operate via fast conditional look-aheads, keeping overall processing cost low. PufferLib environment step speed cannot drop by more than $5\%$ compared to the baseline established in Task 2.Task 4: Curriculum Management Loop & Scale InvarianceDescription: Connect a relative-coordinate metric monitor to your Python training script. Initialize training within a highly confined $3 \times 3$ bounding box containing 1 rabbit. Once the trailing average of the Wolf's "Steps-To-Eat" drops below an optimal threshold (proving tracking proficiency), increment the map size parameters ($3 \times 3 \rightarrow 6 \times 6 \rightarrow 15 \times 15$) directly within the C++ instance pointers.Acceptance Criteria: * The agent successfully tracks down the target on the maximum $15 \times 15$ arena scale without clearing or resetting the network weights during changes.Base Metric & Value: Mean Time-to-Convergence on $15 \times 15$ map $\rightarrow$ Baseline: $\sim 6$ hours (if trained from scratch on a massive map with highly sparse rewards).Expected Post-Task Value: $\le 1$ hour total training time across all curriculum stages combined.Most Critical Metric to Safeguard: Catastrophic Regression on Compact Maps.Guardrail against degradation: Upon clearing the maximum scale stage, run a validation cycle on the original $3 \times 3$ map layout. The model must preserve a $100\%$ success rate and maintain a tracking path near the mathematical optimum. If the success rate drops, it indicates that the neural network's capacity is too narrow, or the curriculum step sizes are overly aggressive.Task 5: Web Client Server Loop & Real-Time PlaybackDescription: Build a simple async Python script hosting a native WebSocket endpoint. This server acts as the live host: it hosts an active instance of your C++ engine, runs real-time inference using the checkpointed PufferLib/PPO policy model at a strict execution cadence ($30\text{ Hz}$ or $60\text{ Hz}$ ticks), and streams the serialized entity string out to the web frontend client.Acceptance Criteria: * A web visualizer client successfully opens a continuous connection, parses the incoming frame arrays, and renders the wolf hunting down rabbits smoothly in real-time.Base Metric & Value: Frame Transmission Cadence $\rightarrow$ Baseline: N/A.Expected Post-Task Value: Steady $60\text{ Hz}$ frame packet delivery with zero frame drops.Most Critical Metric to Safeguard: Inference Loop Latency.Guardrail against degradation: Total frame calculation time—comprising model inference, C++ physics updates, and JSON serialization—must consume $\le 5\text{ ms}$ per frame. Exceeding this threshold will block the real-time server loop, cause packet stuttering, and bottleneck future multi-agent infrastructure scaling.

for any training runs start with like a small 1 minute run to time before scaling up
~
