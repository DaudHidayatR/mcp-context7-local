FROM golang:1.22-alpine AS builder

WORKDIR /app
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /rag-service .

FROM alpine:3.19
RUN apk add --no-cache wget
COPY --from=builder /rag-service /rag-service
EXPOSE 8081
CMD ["/rag-service"]
