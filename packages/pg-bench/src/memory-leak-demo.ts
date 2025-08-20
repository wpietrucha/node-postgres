import { run, bench } from "mitata";
import { Client } from "pg";

const client = new Client({
  host: 'localhost',
  port: 5432,
  database: 'postgres-bench',
  user: 'clickup_admin',
  password: process.env.MONGO_USER_PASSWORD_DEV,
});

await client.connect();

// Helper function to get memory usage in MB
function getMemoryUsageMB() {
  const usage = process.memoryUsage();
  return {
    rss: Math.round(usage.rss / 1024 / 1024 * 100) / 100,
    heapUsed: Math.round(usage.heapUsed / 1024 / 1024 * 100) / 100,
    heapTotal: Math.round(usage.heapTotal / 1024 / 1024 * 100) / 100,
    external: Math.round(usage.external / 1024 / 1024 * 100) / 100
  };
}

// Simulate the memory leak scenario with COPY operations and large data chunks
bench("memory leak simulation - large COPY operations", async () => {
  // Generate a large amount of data that would cause buffer growth
  const largeDataSize = 500000; // 500k rows
  const largeTextPayload = 'X'.repeat(500); // 500 char string per row
  
  // Create a large dataset that will stress the parser buffer management
  const result = await client.query({
    text: `
      WITH large_dataset AS (
        SELECT 
          generate_series(1, $1) as id,
          $2::text as large_text,
          random()::text as random_data,
          NOW()::text as timestamp_data,
          (random() * 1000000)::bigint as large_number
      )
      SELECT * FROM large_dataset
    `,
    values: [largeDataSize, largeTextPayload]
  });

  return result.rows.length;
});

// Benchmark that simulates continuous processing with intermittent large payloads
// This would trigger the buffer growth and partial message scenarios
bench("memory leak simulation - mixed payload sizes", async () => {
  const results = [];
  
  // Simulate the problematic pattern: large payload followed by small ones
  // This creates the scenario where large buffers remain allocated
  
  // First: Large payload (grows buffer significantly)
  const largeResult = await client.query({
    text: `
      SELECT 
        generate_series(1, 100000) as id,
        'Large payload data that will grow the parser buffer significantly: ' || repeat('X', 200) as large_data,
        md5(random()::text) as hash_data
    `
  });
  results.push(largeResult.rows.length);

  // Then: Several smaller payloads (would previously keep large buffer allocated)
  for (let i = 0; i < 10; i++) {
    const smallResult = await client.query({
      text: `SELECT $1::int as small_id, 'small payload' as data`,
      values: [i]
    });
    results.push(smallResult.rows.length);
  }

  return results.reduce((sum, count) => sum + count, 0);
});

// Monitor memory usage during benchmark execution
let memorySnapshots: Array<{time: number, memory: ReturnType<typeof getMemoryUsageMB>}> = [];
const startTime = Date.now();

// Take memory snapshot every 100ms during benchmarks
const memoryMonitor = setInterval(() => {
  memorySnapshots.push({
    time: Date.now() - startTime,
    memory: getMemoryUsageMB()
  });
}, 100);

console.log("🧠 Starting memory leak demonstration benchmark...");
console.log("📊 Initial memory usage:", getMemoryUsageMB());

await run({
  format: 'mitata',
  colors: true,
  throw: true,
});

clearInterval(memoryMonitor);

console.log("\n📈 Memory Usage Analysis:");
console.log("========================");

if (memorySnapshots.length > 0) {
  const initial = memorySnapshots[0].memory;
  const final = memorySnapshots[memorySnapshots.length - 1].memory;
  const peak = memorySnapshots.reduce((max, snapshot) => 
    snapshot.memory.heapUsed > max.heapUsed ? snapshot.memory : max, initial);

  console.log(`Initial Heap: ${initial.heapUsed} MB`);
  console.log(`Peak Heap:    ${peak.heapUsed} MB`);
  console.log(`Final Heap:   ${final.heapUsed} MB`);
  console.log(`RSS Growth:   ${final.rss - initial.rss} MB`);
  console.log(`Heap Growth:  ${final.heapUsed - initial.heapUsed} MB`);
  
  // Calculate memory efficiency
  const memoryRetained = ((final.heapUsed - initial.heapUsed) / (peak.heapUsed - initial.heapUsed)) * 100;
  console.log(`Memory Retention: ${Math.round(memoryRetained)}% of peak usage`);
  
  if (memoryRetained > 80) {
    console.log("⚠️  HIGH MEMORY RETENTION - Potential memory leak detected!");
  } else if (memoryRetained > 50) {
    console.log("⚡ MODERATE MEMORY RETENTION - Some memory not released");
  } else {
    console.log("✅ LOW MEMORY RETENTION - Good memory management");
  }

  // Show memory timeline for significant changes
  console.log("\n📊 Memory Timeline (significant changes):");
  let lastSignificantUsage = initial.heapUsed;
  memorySnapshots.forEach(snapshot => {
    const heapChange = Math.abs(snapshot.memory.heapUsed - lastSignificantUsage);
    if (heapChange > 5) { // Show changes > 5MB
      console.log(`  ${snapshot.time}ms: ${snapshot.memory.heapUsed} MB heap (${heapChange > 0 ? '+' : ''}${Math.round(heapChange)} MB)`);
      lastSignificantUsage = snapshot.memory.heapUsed;
    }
  });
}

console.log("\n🔧 This benchmark demonstrates:");
console.log("• Large buffer allocation during big queries");
console.log("• Buffer management with mixed payload sizes");
console.log("• Memory retention patterns that would indicate leaks");
console.log("• The effectiveness of our gradual buffer shrinking fix");

await client.end();
