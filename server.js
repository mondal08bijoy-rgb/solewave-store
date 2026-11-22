
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DATA = path.join(ROOT, "data");

const pf = path.join(DATA, "products.json");
const of = path.join(DATA, "orders.json");

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const read = (file) =>
  JSON.parse(fs.readFileSync(file, "utf8"));

// FIXED: Correctly handles HTML, CSS, JS and Buffer files.
const send = (res, status, data, type = "application/json; charset=utf-8") => {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store"
  });

  if (Buffer.isBuffer(data) || typeof data === "string") {
    return res.end(data);
  }

  return res.end(JSON.stringify(data));
};

const body = (req) =>
  new Promise((resolve, reject) => {
    let data = "";

    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", reject);
  });

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");

    // GET ALL PRODUCTS
    if (req.method === "GET" && url.pathname === "/api/products") {
      let products = read(pf);

      const query = (url.searchParams.get("q") || "").toLowerCase();
      const category = url.searchParams.get("category") || "All";

      if (query) {
        products = products.filter((product) =>
          (
            product.name + " " +
            product.category + " " +
            product.description
          ).toLowerCase().includes(query)
        );
      }

      if (category !== "All") {
        products = products.filter(
          (product) => product.category === category
        );
      }

      return send(res, 200, products);
    }

    // GET SINGLE PRODUCT
    if (
      req.method === "GET" &&
      url.pathname.startsWith("/api/products/")
    ) {
      const id = url.pathname.split("/").pop();
      const product = read(pf).find((item) => item.id === id);

      return product
        ? send(res, 200, product)
        : send(res, 404, { error: "Product not found" });
    }

    // CREATE ORDER
    if (req.method === "POST" && url.pathname === "/api/orders") {
      const data = await body(req);

      if (
        !data.customer?.name ||
        !data.customer?.phone ||
        !data.items?.length
      ) {
        return send(res, 400, {
          error: "Name, phone and at least one item are required"
        });
      }

      const products = read(pf);
      const items = [];

      for (const item of data.items) {
        const product = products.find((p) => p.id === item.id);
        const quantity = Math.max(
          1,
          Math.min(10, Number(item.qty) || 1)
        );

        if (!product || product.stock < quantity) {
          return send(res, 400, {
            error: "Item unavailable in that quantity"
          });
        }

        items.push({
          id: product.id,
          name: product.name,
          price: product.price,
          qty: quantity,
          size: Number(item.size) || 0
        });
      }

      const orders = read(of);

      const order = {
        id:
          "SW-" +
          Date.now().toString().slice(-7) +
          "-" +
          crypto.randomBytes(2).toString("hex").toUpperCase(),

        createdAt: new Date().toISOString(),

        customer: {
          name: String(data.customer.name).slice(0, 80),
          phone: String(data.customer.phone).slice(0, 30),
          address: String(data.customer.address || "").slice(0, 250)
        },

        items,

        total: items.reduce(
          (sum, item) => sum + item.price * item.qty,
          0
        ),

        status: "Received"
      };

      orders.unshift(order);

      fs.writeFileSync(of, JSON.stringify(orders, null, 2));

      return send(res, 201, {
        message: "Order received",
        order
      });
    }

    // GET ALL ORDERS
    if (req.method === "GET" && url.pathname === "/api/orders") {
      return send(res, 200, read(of));
    }

    // UPDATE ORDER STATUS
    if (
      req.method === "PATCH" &&
      url.pathname.startsWith("/api/orders/")
    ) {
      const data = await body(req);
      const orders = read(of);
      const id = url.pathname.split("/").pop();

      const order = orders.find((item) => item.id === id);

      if (!order) {
        return send(res, 404, {
          error: "Order not found"
        });
      }

      const validStatuses = [
        "Received",
        "Processing",
        "Shipped",
        "Completed",
        "Cancelled"
      ];

      if (validStatuses.includes(data.status)) {
        order.status = data.status;
      }

      fs.writeFileSync(of, JSON.stringify(orders, null, 2));

      return send(res, 200, order);
    }

    // SERVE WEBSITE FILES
    if (req.method === "GET") {
      let requestedPath = decodeURIComponent(url.pathname);

      if (requestedPath === "/") {
        requestedPath = "/index.html";
      }

      const filePath = path.resolve(
        PUBLIC,
        "." + requestedPath
      );

      // Prevent access outside public directory.
      const relativePath = path.relative(PUBLIC, filePath);

      if (
        relativePath.startsWith(".." + path.sep) ||
        relativePath === ".." ||
        path.isAbsolute(relativePath)
      ) {
        return send(res, 403, "Forbidden", "text/plain; charset=utf-8");
      }

      return fs.readFile(filePath, (error, fileData) => {
        if (error) {
          return send(
            res,
            404,
            "Page not found",
            "text/plain; charset=utf-8"
          );
        }

        const extension = path.extname(filePath).toLowerCase();
        const contentType =
          mime[extension] || "application/octet-stream";

        // IMPORTANT: Send original Buffer, not JSON.stringify(Buffer).
        return send(res, 200, fileData, contentType);
      });
    }

    // METHOD NOT ALLOWED
    return send(res, 405, {
      error: "Method not allowed"
    });

  } catch (error) {
    console.error("Server error:", error);

    if (!res.headersSent) {
      return send(res, 500, {
        error: "Server error",
        detail: error.message
      });
    }
  }

}).listen(PORT, "0.0.0.0", () => {
  console.log(`SOLEWAVE live on port ${PORT}`);
});
