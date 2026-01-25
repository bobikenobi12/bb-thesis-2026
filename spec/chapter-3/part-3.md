# 3.4. Проектиране и реализация на IaC шаблоните (Infrastructure as Code)

Тази секция разглежда инфраструктурния слой на платформата Grape, реализиран чрез принципа "Инфраструктура като код" (IaC). В основата му стои пакетът `@repo/templates` (разположен в `packages/templates`), който съдържа така наречените "Златни шаблони" (Golden Templates). Тези шаблони представляват предварително одобрени, сигурни и стандартизирани Terraform конфигурации, които служат като строителни блокове за клиентските среди.

## 3.4.1. Философия на "Златните шаблони"

Концепцията за "Златни шаблони" решава проблема с фрагментацията на инфраструктурата и "drift"-а на конфигурациите. Вместо всеки проект да започва от нулата, Grape използва единен източник на истината.

### 3.4.1.1. Модулен дизайн
Шаблоните са проектирани да бъдат силно модулни, използвайки както официални модули от Terraform Registry (напр. `terraform-aws-modules/vpc/aws`), така и вътрешни модули за специфични нужди. Основният файл `main.tf` дефинира провайдърите (AWS, Kubernetes, Helm), а ресурсната логика е разделена в тематични файлове (`eks.tf`, `rds.tf`, `networking.tf`).

### 3.4.1.2. Условно провизиране (Conditional Provisioning)
Една от ключовите характеристики на тези шаблони е гъвкавостта. Чрез използването на Terraform `count` мета-аргумента и булеви променливи, платформата може да включва или изключва цели компоненти на базата на потребителското намерение.

```hcl
# Пример от packages/templates/rds.tf
module "rds_maindb" {
  count  = var.create_rds ? 1 : 0
  source = "git::git@github.com:itgix/tf-module-rds.git?ref=v1.0.6"
  # ...
}
```

Този подход позволява един и същ шаблон да се използва както за минималистична среда (само EKS), така и за пълна продукционна среда с бази данни и кеширане.

## 3.4.2. Мрежова и изчислителна архитектура

### 3.4.2.1. Мрежов слой (VPC)
Файлът `networking.tf` дефинира Виртуалния частен облак (VPC), който е фундаментът на изолацията. Използва се класическа трислойна архитектура във всяка зона на наличност (Availability Zone):
1.  **Public Subnets:** За Load Balancers и NAT Gateways.
2.  **Private Subnets:** За EKS Node Groups и приложни контейнери.
3.  **Database Subnets:** Строго изолирани мрежи за RDS и ElastiCache.

### 3.4.2.2. Изчислителен слой (EKS)
В `eks.tf` се намира конфигурацията на Kubernetes клъстера. Използва се Amazon EKS (Managed Kubernetes), което освобождава екипа от поддръжка на Control Plane компонентите (etcd, API server).
*   **Managed Node Groups:** Използват се за стандартни работни товари.
*   **Spot Instances:** Конфигурирани за намаляване на разходите при non-critical workloads.
*   **Add-ons:** Автоматично инсталиране на `vpc-cni`, `kube-proxy`, `coredns` и `ebs-csi-driver`.

## 3.4.3. Съхранение на данни и състояние

### 3.4.3.1. Релационни данни (RDS)
Файлът `rds.tf` управлява Amazon Aurora (PostgreSQL) клъстерите. Шаблонът включва:
*   Автоматично управление на мастър потребител и парола чрез AWS Secrets Manager.
*   Encryption at rest (KMS) и in transit (SSL/TLS).
*   Автоматични бекъпи и point-in-time recovery.

### 3.4.3.2. Кеширане (ElastiCache)
За високоскоростен достъп до данни, `elasticache.tf` провизира Redis клъстери. Поддържа се както Cluster Mode (за скалируемост), така и проста Primary-Replica конфигурация.

### 3.4.3.3. Terraform State
Състоянието на Terraform се съхранява в S3 кофа (`backend.tfvars`), защитена с DynamoDB таблица за заключване (state locking). Това предотвратява конфликти при едновременна работа на множество оператори или автоматизирани процеси.

## 3.4.4. Сигурност и съответствие

Сигурността е вградена във всеки аспект на шаблоните ("Secure by Design").

### 3.4.4.1. IAM Roles for Service Accounts (IRSA)
Файлът `irsa.tf` е критичен за реализацията на "Zero-Key" архитектурата. Вместо да се предоставят IAM User Access Keys на под-овете, се използват IAM роли, свързани с Kubernetes Service Accounts чрез OIDC провайдър.
*   **Пример:** `irsa_karpenter` дава права само на Karpenter контролера да управлява EC2 инстанции, без да излага тези права на други приложения.

```hcl
# packages/templates/irsa.tf
module "irsa_karpenter" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  role_name = "KarpenterIRSA-${local.eks_name}"
  # ... OIDC mapping
}
```

### 3.4.4.2. Web Application Firewall (WAF)
В `waf.tf` се дефинират правилата за защита на приложението. Интеграцията е на ниво Application Load Balancer (ALB) или CloudFront. Включени са управлявани от AWS правила (AWS Managed Rules) за защита от SQL Injection, XSS и известни лоши IP адреси.

### 3.4.4.3. Управление на секрети
Шаблоните (`custom_secrets.tf`) използват модул за генериране и съхранение на случайни пароли директно в AWS Secrets Manager. Terraform никога не извежда тези пароли в чист текст в конзолата (освен ако не е изрично поискано с `sensitive = true`), а ги предава чрез референции (ARN) към Kubernetes чрез External Secrets Operator или подобен механизъм.
