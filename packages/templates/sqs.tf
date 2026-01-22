module "sqs_dev" {
  source = "git::git@github.com:itgix/tf-module-sqs-sns.git?ref=v1.0.0"
  count  = var.provision_sqs ? 1 : 0

  sqs_username      = var.sqs_username
  sqs_iam_role_name = var.sqs_iam_role_name
  environment       = var.environment

  sqs_queues = var.sqs_queues

  #sqs_queues = [
  #  for q in var.sqs_queues : {
  #    val[]
  #
  #  }
  #]
  #sqs_queues        = "${var.sqs_queues}_${var.environment}"
  sns_topics = var.sns_topics

  global_tags = local.aws_default_tags
}
