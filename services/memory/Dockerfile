FROM golang:1.22-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /memory-service .

FROM alpine:3.19
RUN apk add --no-cache wget
COPY --from=builder /memory-service /memory-service
EXPOSE 8082
CMD ["/memory-service"]
